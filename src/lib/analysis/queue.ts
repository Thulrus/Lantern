// The analysis scheduler (spec §4.2, §4.4): a priority queue of (item, stage) jobs feeding the
// workers. Results are versioned by (hash, stage, model, params) and cached in IndexedDB, so a
// stage reruns only when its model or version changes. Each stage declares what it requires.
import { BASICS_VERSION } from "./basics";
import { FACES_MODEL, FACES_VERSION, detectFaces, loadFaceDetector } from "./faces";
import { SALIENCY_VERSION } from "./saliency";
import { decodePhoto } from "$lib/media/decode";
import { analysisDb, mediaDb, originalsDb, type AnalysisRecord } from "$lib/store/db";
import { getFile, putFile } from "$lib/store/opfs";
import type { BasicsResult, FaceResult, MediaAnalysis, SaliencyResult } from "$lib/planner/types";
import AnalysisWorker from "../../workers/analysis.worker?worker";

export type StageId = "basics" | "faces";
export const STAGES: { id: StageId; version: number; model: string; requires: StageId[]; priority: number }[] = [
  { id: "basics", version: BASICS_VERSION * 100 + SALIENCY_VERSION, model: "classical", requires: [], priority: 0 },
  { id: "faces", version: FACES_VERSION, model: FACES_MODEL, requires: ["basics"], priority: 1 },
];

export interface StageStatus { hash: string; stage: StageId; status: "queued" | "running" | "ok" | "error" | "skipped"; error?: string }
type Listener = (s: StageStatus) => void;

interface Pending { hash: string; stage: StageId; priority: number; seq: number }

export class AnalysisQueue {
  private workers: { w: Worker; busy: boolean; faces: boolean }[] = [];
  private pending: Pending[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private running = new Set<string>();
  private done = new Map<string, StageStatus>();
  private jobId = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: number) => void }>();
  private paused = false;
  private base: string;
  modelProgress = 0;
  // Vite's dev server forces module workers, where MediaPipe's importScripts loader cannot run:
  // faces run on the main thread in dev (the worker is used in production builds).
  private mainThreadFaces = import.meta.env.DEV;

  constructor(opts: { workers?: number; base: string }) {
    this.base = opts.base;
    const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)), 4));
    for (let i = 0; i < n; i++) {
      const w = new AnalysisWorker();
      const rec = { w, busy: false, faces: false };
      w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; progress?: number }>) => {
        const p = this.waiting.get(e.data.id);
        if (!p) return;
        if (e.data.progress !== undefined) { p.progress?.(e.data.progress); return; }
        this.waiting.delete(e.data.id);
        if (e.data.error !== undefined) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
      };
      this.workers.push(rec);
    }
  }

  onStatus(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(s: StageStatus) { this.done.set(`${s.hash}|${s.stage}`, s); for (const l of this.listeners) l(s); }
  status(hash: string, stage: StageId): StageStatus | undefined { return this.done.get(`${hash}|${stage}`); }

  /** Queue every stage for these items (lower priority number runs first; `boost` promotes). */
  enqueue(hashes: string[], boost = 0): void {
    for (const h of hashes)
      for (const st of STAGES) {
        const key = `${h}|${st.id}`;
        if (this.running.has(key) || this.pending.some((p) => p.hash === h && p.stage === st.id)) continue;
        const d = this.done.get(key);
        if (d && (d.status === "ok" || d.status === "skipped")) continue;
        this.pending.push({ hash: h, stage: st.id, priority: st.priority - boost, seq: this.seq++ });
        this.emit({ hash: h, stage: st.id, status: "queued" });
      }
    this.pump();
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
      // A worker that has the face model resident prefers face jobs, and vice versa.
      let idx = this.pending.findIndex((p) => this.ready(p) && (w.faces ? p.stage === "faces" : p.stage !== "faces"));
      if (idx < 0) idx = this.pending.findIndex((p) => this.ready(p));
      if (idx < 0) return;
      const job = this.pending.splice(idx, 1)[0];
      w.busy = true;
      this.run(w, job).finally(() => { w.busy = false; this.pump(); });
    }
  }

  private ready(p: Pending): boolean {
    const st = STAGES.find((s) => s.id === p.stage)!;
    return st.requires.every((r) => this.done.get(`${p.hash}|${r}`)?.status === "ok");
  }

  private call<T>(w: { w: Worker }, msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: (p: number) => void): Promise<T> {
    const id = ++this.jobId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      w.w.postMessage({ id, ...msg }, transfer);
    });
  }

  private async run(w: { w: Worker; busy: boolean; faces: boolean }, p: Pending): Promise<void> {
    const key = `${p.hash}|${p.stage}`;
    this.running.add(key);
    this.emit({ hash: p.hash, stage: p.stage, status: "running" });
    const st = STAGES.find((s) => s.id === p.stage)!;
    try {
      const cached = await analysisDb.get(p.hash, st.id, st.model, "");
      if (cached && cached.version === st.version && cached.status === "ok") { this.emit({ hash: p.hash, stage: p.stage, status: "ok" }); return; }
      const rec = await mediaDb.get(p.hash);
      if (!rec) throw new Error("media record missing");
      if (rec.info.kind === "video" && st.id === "faces") { this.emit({ hash: p.hash, stage: p.stage, status: "skipped" }); return; }
      let result: unknown;
      if (st.id === "basics") {
        const blob = (await getFile(p.hash, "analysis.webp")) ?? (await getFile(p.hash, "proxy.webp")) ?? (await originalsDb.get(p.hash));
        if (!blob) throw new Error("no image data to analyse");
        const bmp = await decodePhoto(blob);
        result = await this.call<{ basics: BasicsResult; saliency: SaliencyResult }>(w, { kind: "basics", bitmap: bmp, srcW: rec.info.w, srcH: rec.info.h, outHeight: 1080, name: rec.info.name, makeProxies: false }, [bmp]);
      } else {
        const blob = (await getFile(p.hash, "analysis.webp")) ?? (await getFile(p.hash, "proxy.webp"));
        if (!blob) throw new Error("no proxy to analyse");
        const bmp = await decodePhoto(blob);
        w.faces = true;
        if (this.mainThreadFaces) result = await this.facesOnMain(bmp, rec.info.w);
        else {
          try {
            result = await this.call<{ faces: FaceResult[] }>(w, { kind: "faces", bitmap: bmp, srcW: rec.info.w, srcH: rec.info.h, base: this.base }, [bmp], (pr) => { this.modelProgress = pr; });
          } catch (e) {
            // Module workers (the dev server) cannot importScripts MediaPipe's glue: run on the main thread instead.
            if (!/ModuleFactory|importScripts/.test(String(e))) throw e;
            this.mainThreadFaces = true;
            const again = await decodePhoto(blob);
            result = await this.facesOnMain(again, rec.info.w);
          }
        }
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

  private async facesOnMain(bmp: ImageBitmap, srcW: number): Promise<{ faces: FaceResult[] }> {
    const det = await loadFaceDetector(this.base, (d, t) => { this.modelProgress = t ? d / t : 0; });
    const faces = await detectFaces(det, bmp, srcW / bmp.width);
    bmp.close();
    return { faces };
  }

  private free(): Promise<{ w: Worker; busy: boolean; faces: boolean }> {
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
  }
  return out;
}
