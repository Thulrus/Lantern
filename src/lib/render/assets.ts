// Asset loading for the preview (spec §9.2): proxies from OPFS for a window of slides around the
// playhead (3 ahead, 1 behind), uploaded as textures within a memory budget. Videos play
// through <video> elements whose frames are uploaded each tick.
import type { RenderSlide, Timeline } from "$lib/planner/types";
import { getFile } from "$lib/store/opfs";
import { originalsDb } from "$lib/store/db";
import { decodePhoto } from "$lib/media/decode";
import type { Renderer } from "./renderer";

const AHEAD = 3, BEHIND = 1;

export class AssetLoader {
  private loading = new Map<string, Promise<void>>();
  private videos = new Map<string, HTMLVideoElement>();
  private order: string[] = [];
  private failed = new Set<string>();
  budget: number;

  constructor(private r: Renderer, opts: { budget?: number } = {}) { this.budget = opts.budget ?? 24; }

  private imagesOf(s: RenderSlide): { hash: string; video?: boolean }[] {
    if (s.cells) return s.cells.flatMap((c) => this.imagesOf(c.slide));
    const out: { hash: string; video?: boolean }[] = [];
    if (s.assets.video) out.push({ hash: s.assets.video.hash, video: true });
    else if (s.assets.image) out.push({ hash: s.assets.image.hash });
    return out;
  }

  /** Make sure the window around t is loaded; returns true when the slides at t are ready. */
  async ensure(tl: Timeline, t: number): Promise<boolean> {
    const i = tl.layers.findIndex((l) => t < l.t1);
    const idx = i < 0 ? tl.layers.length - 1 : i;
    const wanted: { hash: string; video?: boolean }[] = [];
    for (let k = Math.max(0, idx - BEHIND); k <= Math.min(tl.layers.length - 1, idx + AHEAD); k++) wanted.push(...this.imagesOf(tl.layers[k]));
    const now = tl.layers.filter((l) => t >= l.t0 && t < l.t1).flatMap((l) => this.imagesOf(l));
    const jobs = wanted.map((w) => this.load(w.hash, !!w.video));
    const keep = new Set(wanted.map((w) => w.hash));
    for (const k of this.r.keys()) {
      if (keep.has(k) || keep.has(k.replace(/^v:/, "")) || k.startsWith("maps:")) continue;
      if (this.order.length > this.budget) { this.r.drop(k); this.order = this.order.filter((x) => x !== k); }
    }
    await Promise.all(now.map((w) => this.load(w.hash, !!w.video)));
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
        this.failed.add(hash);
      } finally {
        this.loading.delete(hash);
      }
    })();
    this.loading.set(hash, p);
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
