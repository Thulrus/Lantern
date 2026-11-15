// Asset loading for the preview (spec §9.2): proxies from OPFS for a window of slides around the
// playhead (3 ahead, 1 behind), uploaded as textures within a memory budget. Videos play
// through <video> elements whose frames are uploaded each tick.
import type { RenderSlide, Timeline } from "$lib/planner/types";
import { getFile } from "$lib/store/opfs";
import { originalsDb } from "$lib/store/db";
import { decodePhoto } from "$lib/media/decode";
import type { Renderer } from "./renderer";
import { decodeDepth, decodePlanes } from "$lib/analysis/depthmath";
import { composeMaps } from "$lib/analysis/layers";

const AHEAD = 3, BEHIND = 1;
type Want = { hash: string; video?: boolean; maps?: boolean; plate?: boolean };

/** Generated plates (plategen.webp, spec §4.6) are used instead of the classical plate while the
 *  project's generative fill reaches plates. `layerEpoch` bumps whenever that or a photo's plate
 *  changes, so loaders re-upload layer textures. */
let generatedPlates = false;
let globalEpoch = 0;
const hashEpoch = new Map<string, number>();
export function setGeneratedPlates(on: boolean): void { if (on !== generatedPlates) { generatedPlates = on; globalEpoch++; } }
export function invalidateLayers(hash: string): void { hashEpoch.set(hash, (hashEpoch.get(hash) ?? 0) + 1); }
const epochOf = (hash: string) => `${globalEpoch}.${hashEpoch.get(hash) ?? 0}`;

/** Read depth.u16.gz, platedepth.u16.gz and (with a subject layer) matte.u8.gz + plate.webp from
 *  OPFS and upload the maps texture "maps:<hash>" and the plate "plate:<hash>". Shared by the
 *  preview loader and the exporter. */
export async function loadLayerTextures(r: Renderer, hash: string, plate: boolean): Promise<void> {
  const [dBlob, bgBlob, mBlob, pBlob] = await Promise.all([
    getFile(hash, "depth.u16.gz"), getFile(hash, "platedepth.u16.gz"),
    plate ? getFile(hash, "matte.u8.gz") : null,
    plate ? (generatedPlates ? getFile(hash, "plategen.webp") : Promise.resolve(null)).then((g) => g ?? getFile(hash, "plate.webp")) : null,
  ]);
  if (!dBlob) throw new Error("no depth file");
  const d = await decodeDepth(dBlob);
  const bg = bgBlob ? await decodeDepth(bgBlob) : d;
  let matte: { tight: Uint8Array; grown: Uint8Array } | null = null;
  if (mBlob && pBlob) {
    const m = await decodePlanes(mBlob);
    if (m.w === d.w && m.h === d.h && m.planes.length >= 2) matte = { tight: m.planes[0], grown: m.planes[1] };
  }
  if (matte && pBlob) {
    const bmp = await createImageBitmap(pBlob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    r.upload("plate:" + hash, bmp, false);
    bmp.close();
  }
  r.uploadMaps("maps:" + hash, composeMaps(d.u16, bg.w === d.w && bg.h === d.h ? bg.u16 : d.u16, matte, d.w, d.h), d.w, d.h);
}

export class AssetLoader {
  private loading = new Map<string, Promise<void>>();
  private videos = new Map<string, HTMLVideoElement>();
  private order: string[] = [];
  private failed = new Map<string, string>();   // key → layer epoch it failed at
  private epochs = new Map<string, string>();   // maps key → layer epoch it was loaded at
  budget: number;

  constructor(private r: Renderer, opts: { budget?: number } = {}) { this.budget = opts.budget ?? 24; }

  private imagesOf(s: RenderSlide): Want[] {
    if (s.cells) return s.cells.flatMap((c) => this.imagesOf(c.slide));
    const out: Want[] = [];
    if (s.assets.video) out.push({ hash: s.assets.video.hash, video: true });
    else if (s.assets.image) out.push({ hash: s.assets.image.hash, maps: !!s.assets.maps, plate: !!s.assets.plate });
    return out;
  }

  /** Make sure the window around t is loaded; returns true when the slides at t are ready. */
  async ensure(tl: Timeline, t: number): Promise<boolean> {
    const i = tl.layers.findIndex((l) => t < l.t1);
    const idx = i < 0 ? tl.layers.length - 1 : i;
    const wanted: Want[] = [];
    for (let k = Math.max(0, idx - BEHIND); k <= Math.min(tl.layers.length - 1, idx + AHEAD); k++) wanted.push(...this.imagesOf(tl.layers[k]));
    const now = tl.layers.filter((l) => t >= l.t0 && t < l.t1).flatMap((l) => this.imagesOf(l));
    const jobs = wanted.map((w) => Promise.all([this.load(w.hash, !!w.video), w.maps ? this.loadMaps(w.hash, !!w.plate) : undefined]));
    const keep = new Set(wanted.map((w) => w.hash));
    for (const k of this.r.keys()) {
      if (keep.has(k) || keep.has(k.replace(/^(v|maps):/, ""))) continue;
      if (this.order.length > this.budget) { this.r.drop(k); this.r.drop("maps:" + k); this.r.drop("plate:" + k); this.order = this.order.filter((x) => x !== k); }
    }
    await Promise.all(now.map((w) => Promise.all([this.load(w.hash, !!w.video), w.maps ? this.loadMaps(w.hash, !!w.plate) : undefined])));
    void jobs;
    return now.every((w) => this.r.has(w.hash) || this.r.has("v:" + w.hash) || this.failed.has(w.hash));
  }

  load(hash: string, video: boolean): Promise<void> {
    if (this.r.has(hash) || this.failed.has(hash)) return Promise.resolve();
    let p = this.loading.get(hash);
    if (p) return p;
    p = (async () => {
      try {
        if (video) {
          const blob = await originalsDb.get(hash);
          if (!blob) throw new Error("video original missing");
          const v = document.createElement("video");
          v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(blob);
          await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("video load failed")); });
          this.videos.set(hash, v);
        }
        const blob = (await getFile(hash, "proxy.webp")) ?? (await getFile(hash, "analysis.webp")) ?? (await originalsDb.get(hash));
        if (!blob) throw new Error("no proxy");
        const bmp = await decodePhoto(blob);
        this.r.upload(hash, bmp, true);
        bmp.close();
        this.order.push(hash);
      } catch {
        this.failed.set(hash, "");
      } finally {
        this.loading.delete(hash);
      }
    })();
    this.loading.set(hash, p);
    return p;
  }

  /** The maps texture (and plate) for a photo from its layer files; a missing file leaves the slide flat. */
  loadMaps(hash: string, plate: boolean): Promise<void> {
    const key = "maps:" + hash, ep = epochOf(hash);
    if ((this.r.has(key) && this.epochs.get(key) === ep) || this.failed.get(key) === ep) return Promise.resolve();
    let p = this.loading.get(key);
    if (p) return p;
    p = loadLayerTextures(this.r, hash, plate).then(() => { this.epochs.set(key, ep); }, () => { this.failed.set(key, ep); }).finally(() => { this.loading.delete(key); });
    this.loading.set(key, p);
    return p;
  }

  /** Seek the <video> elements of the active clips and upload their current frame. */
  tickVideo(tl: Timeline, t: number, playing: boolean): void {
    for (const l of tl.layers) {
      const vh = l.assets.video?.hash;
      if (!vh) continue;
      const v = this.videos.get(vh);
      if (!v) continue;
      const active = t >= l.t0 - 1 && t < l.t1;
      if (!active) { if (!v.paused) v.pause(); continue; }
      const local = (l.clip?.in ?? 0) + Math.max(0, t - l.t0) * (l.clip?.speed ?? 1);
      if (playing && t >= l.t0) { if (v.paused) { v.currentTime = local; v.play().catch(() => {}); } else if (Math.abs(v.currentTime - local) > 0.3) v.currentTime = local; }
      else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - local) > 0.05) v.currentTime = local; }
      if (v.readyState >= 2) this.r.upload("v:" + vh, v, false);
    }
  }

  dispose(): void {
    for (const v of this.videos.values()) { v.pause(); URL.revokeObjectURL(v.src); }
    this.videos.clear();
  }
}
