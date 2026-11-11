// Analysis worker (spec §3): one job at a time; the face detector and the depth session stay resident. Jobs carry an ImageBitmap
// (transferred) and return results plus derived files as blobs. The main thread owns the queue.
import { basics } from "$lib/analysis/basics";
import { saliency } from "$lib/analysis/saliency";
import { detectFaces, loadFaceDetector, unloadFaceDetector } from "$lib/analysis/faces";
import { estimateDepth, loadDepth, unloadDepth } from "$lib/analysis/depth";
import { depthStats, encodeDepth, normalizeDepth, reliefOf } from "$lib/analysis/depthmath";
import type { Box } from "$lib/planner/types";
import { ANALYSIS_EDGE, PROXY_EDGE, THUMB_EDGE, encodeWebp, resizeBitmap } from "$lib/media/decode";

export type Job =
  | { id: number; kind: "basics"; bitmap: ImageBitmap; srcW: number; srcH: number; outHeight: number; name: string; makeProxies: boolean }
  | { id: number; kind: "faces"; bitmap: ImageBitmap; srcW: number; srcH: number; base: string }
  | { id: number; kind: "depth"; bitmap: ImageBitmap; srcW: number; srcH: number; base: string; edge: number; subject: Box | null }
  | { id: number; kind: "unload" };

self.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.kind === "unload") { unloadFaceDetector(); await unloadDepth(); self.postMessage({ id: job.id, result: null }); return; }
    if (job.kind === "basics") {
      const a = resizeBitmap(job.bitmap, ANALYSIS_EDGE);
      const img = a.canvas.getContext("2d")!.getImageData(0, 0, a.w, a.h);
      const b = basics(img.data, a.w, a.h, job.srcW, job.srcH, job.outHeight, job.name);
      const grey = new Float32Array(a.w * a.h);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) grey[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      const sal = saliency(grey, a.w, a.h, job.srcW, job.srcH);
      let thumb: Blob | null = null, proxy: Blob | null = null, analysis: Blob | null = null;
      if (job.makeProxies) {
        const t = resizeBitmap(job.bitmap, THUMB_EDGE);
        thumb = await encodeWebp(t.canvas, 0.8);
        const p = resizeBitmap(job.bitmap, PROXY_EDGE);
        proxy = await encodeWebp(p.canvas, 0.86);
        analysis = await encodeWebp(a.canvas, 0.85);
      }
      job.bitmap.close();
      self.postMessage({ id: job.id, result: { basics: b, saliency: sal, thumb, proxy, analysis } });
      return;
    }
    if (job.kind === "faces") {
      const det = await loadFaceDetector(job.base, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      const scale = job.srcW / job.bitmap.width;
      const faces = await detectFaces(det, job.bitmap, scale);
      job.bitmap.close();
      self.postMessage({ id: job.id, result: { faces } });
      return;
    }
    if (job.kind === "depth") {
      const s = await loadDepth(job.base, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      const t0 = performance.now();
      const { raw, w, h } = await estimateDepth(s, job.bitmap, job.edge);
      job.bitmap.close();
      const norm = normalizeDepth(raw);
      const stats = depthStats(norm.u16, w, h, { lo: norm.lo, hi: norm.hi, cv: reliefOf(raw) }, job.subject, job.srcW, job.srcH);
      const file = await encodeDepth(norm.u16, w, h);
      self.postMessage({ id: job.id, result: { depth: stats, file, ms: performance.now() - t0 } });
      return;
    }
  } catch (err) {
    self.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
};
