// The analysis scheduler (spec §4.2, §4.4): a priority queue of (item, stage) jobs feeding the
// workers. Results are versioned by (hash, stage, model, params) and cached in IndexedDB, so a
// stage reruns only when its model or version changes. Each stage declares what it requires.
import { BASICS_VERSION } from "./basics";
import { FACES_MODEL, FACES_VERSION, detectFaces, loadFaceDetector } from "./faces";
import { SALIENCY_VERSION } from "./saliency";
import { DEPTH_EDGE_FULL, DEPTH_EDGE_LITE, DEPTH_MODEL, DEPTH_VERSION } from "./depth";
import { subjectRegion } from "./depthmath";
import { FILL_ATTEMPTS, FILL_MODEL, FILL_VERSION, faceLimit, inventedFace, inventedPerson } from "./fill";
import { detectPersons, loadPersonDetector, loadSegmenter, segmentPeople, type PersonBox } from "./persons";
import { quickTier } from "$lib/media/tier";
import { decodePhoto } from "$lib/media/decode";
import { analysisDb, mediaDb, originalsDb, type AnalysisRecord } from "$lib/store/db";
import { deleteFile, getFile, putFile } from "$lib/store/opfs";
import type { BasicsResult, DepthInfo, FaceResult, MediaAnalysis, SaliencyResult } from "$lib/planner/types";
import AnalysisWorker from "../../workers/analysis.worker?worker";

export type StageId = "basics" | "faces" | "depth" | "fill";
const DEPTH_STALL_MS = 90_000;   // a hung session never returns; a slow phone inference should still fit
class StallError extends Error {}
export const STAGES: { id: StageId; version: number; model: string; requires: StageId[]; priority: number }[] = [
  { id: "basics", version: BASICS_VERSION * 100 + SALIENCY_VERSION, model: "classical", requires: [], priority: 0 },
  { id: "faces", version: FACES_VERSION, model: FACES_MODEL, requires: ["basics"], priority: 1 },
  { id: "depth", version: DEPTH_VERSION, model: DEPTH_MODEL, requires: ["basics", "faces"], priority: 2 },
  // Generative plate fill; runs only while the project's generative fill covers plates (setFill).
  { id: "fill", version: DEPTH_VERSION * 100 + FILL_VERSION, model: FILL_MODEL, requires: ["depth"], priority: 3 },
];

export interface StageStatus { hash: string; stage: StageId; status: "queued" | "running" | "ok" | "error" | "skipped"; error?: string }
type Listener = (s: StageStatus) => void;

interface Pending { hash: string; stage: StageId; priority: number; seq: number }
/** `resident`: the model stages this worker has loaded, so jobs prefer a worker that already holds their model. */
type WorkerRec = { w: Worker; busy: boolean; resident: Set<StageId> };

export class AnalysisQueue {
  private workers: WorkerRec[] = [];
  private pending: Pending[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private running = new Set<string>();
  private done = new Map<string, StageStatus>();
  private jobId = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: number) => void; touch: () => void }>();
  private paused = false;
  private base: string;
  /** Multi-threaded ONNX Runtime; turned off for the session after a job stalls (see `call`). */
  private ortThreads = true;
  modelProgress = 0;
  /** Whether the generative fill stage runs (the project's generative fill reaches plates). */
  private fillOn = false;
  /** Model input short edge for depth: smaller on the lite tier (spec §2.2). */
  private depthEdge = quickTier() === "lite" ? DEPTH_EDGE_LITE : DEPTH_EDGE_FULL;
  // Vite's dev server forces module workers, where MediaPipe's importScripts loader cannot run:
  // faces run on the main thread in dev (the worker is used in production builds).
  private mainThreadFaces = import.meta.env.DEV;

  constructor(opts: { workers?: number; base: string }) {
    this.base = opts.base;
    const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)), 4));
    for (let i = 0; i < n; i++) {
      this.workers.push(this.spawn());
    }
  }

  private spawn(): WorkerRec {
    const w = new AnalysisWorker();
    const rec: WorkerRec = { w, busy: false, resident: new Set() };
    w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; progress?: number }>) => {
      const p = this.waiting.get(e.data.id);
      if (!p) return;
      p.touch();
      if (e.data.progress !== undefined) { p.progress?.(e.data.progress); return; }
      this.waiting.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    return rec;
  }

  /** Replace a worker that stopped answering (a hung WASM runtime): terminate it and start a
   *  fresh one in its place; the record keeps its identity so in-flight bookkeeping still works. */
  private replace(rec: WorkerRec): void {
    rec.w.terminate();
    const fresh = this.spawn();
    rec.w = fresh.w;
    rec.resident = new Set();
  }

  onStatus(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(s: StageStatus) { this.done.set(`${s.hash}|${s.stage}`, s); for (const l of this.listeners) l(s); }
  status(hash: string, stage: StageId): StageStatus | undefined { return this.done.get(`${hash}|${stage}`); }

  /** Queue every stage for these items (lower priority number runs first; `boost` promotes). */
  enqueue(hashes: string[], boost = 0): void {
    for (const h of hashes)
      for (const st of STAGES) {
        if (st.id === "fill" && !this.fillOn) continue;
        const key = `${h}|${st.id}`;
        if (this.running.has(key) || this.pending.some((p) => p.hash === h && p.stage === st.id)) continue;
        const d = this.done.get(key);
        if (d && (d.status === "ok" || d.status === "skipped")) continue;
        this.pending.push({ hash: h, stage: st.id, priority: st.priority - boost, seq: this.seq++ });
        this.emit({ hash: h, stage: st.id, status: "queued" });
      }
    this.pump();
  }

  /** Turn the generative fill stage on or off; turning it on queues it for `hashes`. */
  setFill(on: boolean, hashes: string[]): void {
    this.fillOn = on;
    if (on) this.enqueue(hashes);
    else { this.pending = this.pending.filter((p) => p.stage !== "fill"); }
  }

  /** Promote items near the playhead (spec §4.4). */
  promote(hashes: string[]): void {
    const set = new Set(hashes);
    for (const p of this.pending) if (set.has(p.hash)) p.priority -= 10;
    this.pump();
  }

  pause(v: boolean): void { this.paused = v; this.pump(); }
  get queued(): number { return this.pending.length + this.running.size; }

  private pump(): void {
    if (this.paused) return;
    for (const w of this.workers) {
      if (w.busy || !this.pending.length) continue;
      this.pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      // A worker that has a model resident prefers that model's jobs; a fresh worker takes
      // anything, but leaves model stages to a worker that already holds the model if one exists.
      const holder = (st: StageId) => this.workers.some((o) => o !== w && o.resident.has(st));
      let idx = this.pending.findIndex((p) => this.ready(p) && w.resident.has(p.stage));
      if (idx < 0) idx = this.pending.findIndex((p) => this.ready(p) && (p.stage === "basics" || !holder(p.stage)));
      if (idx < 0) idx = this.pending.findIndex((p) => this.ready(p));
      if (idx < 0) return;
      const job = this.pending.splice(idx, 1)[0];
      w.busy = true;
      this.run(w, job).finally(() => { w.busy = false; this.pump(); });
    }
  }

  private ready(p: Pending): boolean {
    const st = STAGES.find((s) => s.id === p.stage)!;
    return st.requires.every((r) => { const d = this.done.get(`${p.hash}|${r}`)?.status; return d === "ok" || d === "skipped"; });
  }

  /** Post a job to a worker. With `stallMs`, a job that sends nothing (no progress, no result)
   *  for that long is abandoned: the worker is replaced and the call rejects with StallError. */
  private call<T>(w: WorkerRec, msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: (p: number) => void, stallMs = 0): Promise<T> {
    const id = ++this.jobId;
    return new Promise<T>((resolve, reject) => {
      let timer = 0;
      const arm = () => {
        if (!stallMs) return;
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          this.waiting.delete(id);
          this.replace(w);
          reject(new StallError(`worker sent nothing for ${stallMs / 1000} s`));
        }, stallMs);
      };
      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        progress, touch: arm,
      });
      arm();
      w.w.postMessage({ id, ...msg }, transfer);
    });
  }

  private async run(w: WorkerRec, p: Pending): Promise<void> {
    const key = `${p.hash}|${p.stage}`;
    this.running.add(key);
    this.emit({ hash: p.hash, stage: p.stage, status: "running" });
    const st = STAGES.find((s) => s.id === p.stage)!;
    try {
      const cached = await analysisDb.get(p.hash, st.id, st.model, "");
      if (cached && cached.version === st.version && cached.status === "ok") { this.emit({ hash: p.hash, stage: p.stage, status: "ok" }); return; }
      const rec = await mediaDb.get(p.hash);
      if (!rec) throw new Error("media record missing");
      if (rec.info.kind === "video" && st.id !== "basics") { this.emit({ hash: p.hash, stage: p.stage, status: "skipped" }); return; }
      let result: unknown;
      if (st.id === "basics") {
        const blob = (await getFile(p.hash, "analysis.webp")) ?? (await getFile(p.hash, "proxy.webp")) ?? (await originalsDb.get(p.hash));
        if (!blob) throw new Error("no image data to analyse");
        const bmp = await decodePhoto(blob);
        result = await this.call<{ basics: BasicsResult; saliency: SaliencyResult }>(w, { kind: "basics", bitmap: bmp, srcW: rec.info.w, srcH: rec.info.h, outHeight: 1080, name: rec.info.name, makeProxies: false }, [bmp]);
      } else if (st.id === "depth") {
        const blob = (await getFile(p.hash, "analysis.webp")) ?? (await getFile(p.hash, "proxy.webp"));
        if (!blob) throw new Error("no proxy to analyse");
        const prior = await loadAnalysis(p.hash);
        const strong = (prior?.faces ?? []).filter((f) => f.score >= 0.5), weak = (prior?.faces ?? []).filter((f) => f.score >= 0.4);
        const faces = (strong.length ? strong : weak).map((f) => f.box);
        const subject = subjectRegion(faces, (prior?.saliency?.peaks ?? []).map((x) => x.box), rec.info.w, rec.info.h);
        w.resident.add("depth");
        // Person mask first (coarse, any device) so the matte keeps whole people; a failure only loses the refinement.
        const people = await this.runSegment(w, () => decodePhoto(blob)).catch(() => null);
        const depthJob = async (threads: boolean) => {
          const bmp = await decodePhoto(blob);
          return this.call<{ depth: Omit<DepthInfo, "available">; file: Blob; bgFile: Blob; matteFile: Blob | null; plateFile: Blob | null; peopleFile: Blob | null; ms: number; layersMs: number }>(w, { kind: "depth", bitmap: bmp, srcW: rec.info.w, srcH: rec.info.h, base: this.base, edge: this.depthEdge, subject, faces: weak.map((f) => f.box), people: people ? { ...people, mask: people.mask.slice() } : null, threads }, [bmp], (pr) => { this.modelProgress = pr; }, DEPTH_STALL_MS);
        };
        let r: Awaited<ReturnType<typeof depthJob>>;
        try {
          r = await depthJob(this.ortThreads);
        } catch (e) {
          // A stalled runtime (multi-threaded session creation hung in headless Chromium): once
          // more on a fresh worker, single-threaded; threads stay off for the rest of the session.
          if (!(e instanceof StallError)) throw e;
          this.ortThreads = false;
          r = await depthJob(false);
        }
        await putFile(p.hash, "depth.u16.gz", r.file);
        await putFile(p.hash, "platedepth.u16.gz", r.bgFile);
        if (r.matteFile) await putFile(p.hash, "matte.u8.gz", r.matteFile);
        if (r.plateFile) await putFile(p.hash, "plate.webp", r.plateFile);
        if (r.peopleFile) await putFile(p.hash, "people.u8.gz", r.peopleFile);
        result = { depth: r.depth, ms: r.ms, layersMs: r.layersMs };
      } else if (st.id === "fill") {
        const [blob, matte] = await Promise.all([getFile(p.hash, "analysis.webp").then((b) => b ?? getFile(p.hash, "proxy.webp")), getFile(p.hash, "matte.u8.gz")]);
        if (!blob || !matte) { this.emit({ hash: p.hash, stage: p.stage, status: "skipped" }); return; }
        // People on the original, in source pixels: kept out of the model's context, and the reference for the guard.
        const people = (await this.runPersons(w, () => decodePhoto(blob), rec.info.w, rec.info.h)).persons;
        w.resident.add("fill");
        const peopleMask = await getFile(p.hash, "people.u8.gz");
        let rejected: string | null = null, plateFile: Blob | null = null, rejectedFile: Blob | null = null, ms = 0, tries = 0;
        for (let attempt = 0; attempt < FILL_ATTEMPTS.length; attempt++) {
          tries++;
          const bmp = await decodePhoto(blob);
          const r = await this.call<{ plateFile: Blob | null; guard: ImageBitmap | null; generated: Uint8Array; w: number; h: number; ms: number }>(w, { kind: "fill", bitmap: bmp, matte, base: this.base, threads: this.ortThreads, people, peopleMask, srcW: rec.info.w, srcH: rec.info.h, attempt }, [bmp], (pr) => { this.modelProgress = pr; }, DEPTH_STALL_MS);
          ms += r.ms;
          if (!r.guard || !r.plateFile) { rejected = null; break; }
          const g = r.guard, sx = r.w / rec.info.w, sy = r.h / rec.info.h;
          const faces = (await this.runFaces(w, () => createImageBitmap(g), r.w, r.h)).faces;
          const found = (await this.runPersons(w, () => createImageBitmap(g), r.w, r.h)).persons;
          g.close();
          const orig = people.map((q) => ({ box: [q.box[0] * sx, q.box[1] * sy, q.box[2] * sx, q.box[3] * sy] as [number, number, number, number] }));
          const realSides = ((await loadAnalysis(p.hash))?.faces ?? []).map((f) => Math.max((f.box[2] - f.box[0]) * sx, (f.box[3] - f.box[1]) * sy));
          rejected = inventedFace(faces, r.generated, r.w, r.h, faceLimit(realSides, r.w, r.h)) ? "face in generated pixels" : inventedPerson(found, orig, r.generated, r.w, r.h) ? "person in generated pixels" : null;
          if (!rejected) { plateFile = r.plateFile; break; }
          rejectedFile = r.plateFile;
          console.info(`[fill] ${p.hash.slice(0, 8)} attempt ${attempt + 1} rejected: ${rejected}`, JSON.stringify(faces.filter((f) => f.score >= 0.5).map((f) => [f.box.map(Math.round), +f.score.toFixed(2)])));
        }
        if (plateFile) await putFile(p.hash, "plategen.webp", plateFile);
        else await deleteFile(p.hash, "plategen.webp").catch(() => {});
        if (rejectedFile) await putFile(p.hash, "plategen.rejected.webp", rejectedFile);   // the last rejected attempt, for inspection only
        else await deleteFile(p.hash, "plategen.rejected.webp").catch(() => {});
        result = { fill: { ok: !!plateFile, rejected: plateFile ? null : rejected, tries, ms } };
      } else {
        const blob = (await getFile(p.hash, "analysis.webp")) ?? (await getFile(p.hash, "proxy.webp"));
        if (!blob) throw new Error("no proxy to analyse");
        result = await this.runFaces(w, () => decodePhoto(blob), rec.info.w, rec.info.h);
      }
      const row: AnalysisRecord = { key: analysisDb.key(p.hash, st.id, st.model, ""), hash: p.hash, stage: st.id, model: st.model, params: "", version: st.version, status: "ok", result, updated: Date.now() };
      await analysisDb.put(row);
      this.emit({ hash: p.hash, stage: p.stage, status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await analysisDb.put({ key: analysisDb.key(p.hash, st.id, st.model, ""), hash: p.hash, stage: st.id, model: st.model, params: "", version: st.version, status: "error", result: null, error: msg, updated: Date.now() });
      this.emit({ hash: p.hash, stage: p.stage, status: "error", error: msg });
    } finally {
      this.running.delete(key);
    }
  }

  /** Run basics on a freshly decoded bitmap at import time, producing the derived files too. */
  async importBasics(hash: string, bmp: ImageBitmap, srcW: number, srcH: number, name: string): Promise<{ basics: BasicsResult; saliency: SaliencyResult }> {
    const w = await this.free();
    w.busy = true;
    try {
      const r = await this.call<{ basics: BasicsResult; saliency: SaliencyResult; thumb: Blob | null; proxy: Blob | null; analysis: Blob | null }>(w, { kind: "basics", bitmap: bmp, srcW, srcH, outHeight: 1080, name, makeProxies: true }, [bmp]);
      if (r.thumb) await putFile(hash, "thumb.webp", r.thumb);
      if (r.proxy) await putFile(hash, "proxy.webp", r.proxy);
      if (r.analysis) await putFile(hash, "analysis.webp", r.analysis);
      const st = STAGES[0];
      await analysisDb.put({ key: analysisDb.key(hash, st.id, st.model, ""), hash, stage: st.id, model: st.model, params: "", version: st.version, status: "ok", result: { basics: r.basics, saliency: r.saliency }, updated: Date.now() });
      this.emit({ hash, stage: "basics", status: "ok" });
      return { basics: r.basics, saliency: r.saliency };
    } finally {
      w.busy = false;
      this.pump();
    }
  }

  /** Face detection on a worker, or on the main thread where workers cannot load MediaPipe (dev). */
  private async runFaces(w: WorkerRec, bitmap: () => Promise<ImageBitmap>, srcW: number, srcH: number): Promise<{ faces: FaceResult[] }> {
    w.resident.add("faces");
    if (this.mainThreadFaces) return this.facesOnMain(await bitmap(), srcW);
    try {
      return await this.call<{ faces: FaceResult[] }>(w, { kind: "faces", bitmap: await bitmap(), srcW, srcH, base: this.base }, [], (pr) => { this.modelProgress = pr; });
    } catch (e) {
      // Module workers (the dev server) cannot importScripts MediaPipe's glue: run on the main thread instead.
      if (!/ModuleFactory|importScripts/.test(String(e))) throw e;
      this.mainThreadFaces = true;
      return this.facesOnMain(await bitmap(), srcW);
    }
  }

  /** Person mask (DeepLab), on a worker or (dev) on the main thread. */
  private async runSegment(w: WorkerRec, bitmap: () => Promise<ImageBitmap>): Promise<{ mask: Uint8Array; w: number; h: number }> {
    const onMain = async () => {
      const seg = await loadSegmenter(this.base, (d, t) => { this.modelProgress = t ? d / t : 0; });
      const b = await bitmap();
      const r = segmentPeople(seg, b);
      b.close();
      return r;
    };
    if (this.mainThreadFaces) return onMain();
    try {
      return await this.call<{ mask: Uint8Array; w: number; h: number }>(w, { kind: "segment", bitmap: await bitmap(), base: this.base }, [], (pr) => { this.modelProgress = pr; });
    } catch (e) {
      if (!/ModuleFactory|importScripts/.test(String(e))) throw e;
      this.mainThreadFaces = true;
      return onMain();
    }
  }

  /** Person boxes, on a worker or (dev) on the main thread, like faces. */
  private async runPersons(w: WorkerRec, bitmap: () => Promise<ImageBitmap>, srcW: number, srcH: number): Promise<{ persons: PersonBox[] }> {
    const onMain = async () => {
      const det = await loadPersonDetector(this.base, (d, t) => { this.modelProgress = t ? d / t : 0; });
      const b = await bitmap();
      const persons = detectPersons(det, b, srcW / b.width);
      b.close();
      return { persons };
    };
    if (this.mainThreadFaces) return onMain();
    try {
      return await this.call<{ persons: PersonBox[] }>(w, { kind: "persons", bitmap: await bitmap(), srcW, srcH, base: this.base }, [], (pr) => { this.modelProgress = pr; });
    } catch (e) {
      if (!/ModuleFactory|importScripts/.test(String(e))) throw e;
      this.mainThreadFaces = true;
      return onMain();
    }
  }

  private async facesOnMain(bmp: ImageBitmap, srcW: number): Promise<{ faces: FaceResult[] }> {
    const det = await loadFaceDetector(this.base, (d, t) => { this.modelProgress = t ? d / t : 0; });
    const faces = await detectFaces(det, bmp, srcW / bmp.width);
    bmp.close();
    return { faces };
  }

  private free(): Promise<WorkerRec> {
    return new Promise((res) => {
      const tick = () => { const f = this.workers.find((w) => !w.busy); if (f) res(f); else setTimeout(tick, 30); };
      tick();
    });
  }

  dispose(): void { for (const w of this.workers) w.w.terminate(); }
}

/** Assemble a MediaAnalysis from the cached records. */
export async function loadAnalysis(hash: string): Promise<MediaAnalysis | null> {
  const rec = await mediaDb.get(hash);
  if (!rec) return null;
  const out: MediaAnalysis = { info: rec.info };
  for (const r of await analysisDb.forHash(hash)) {
    if (r.status !== "ok") continue;
    if (r.stage === "basics") { const x = r.result as { basics: BasicsResult; saliency: SaliencyResult }; out.basics = x.basics; out.saliency = x.saliency; }
    if (r.stage === "faces") out.faces = (r.result as { faces: FaceResult[] }).faces;
    if (r.stage === "depth") out.depth = { available: true, ...(r.result as { depth: Omit<DepthInfo, "available"> }).depth };
  }
  return out;
}
