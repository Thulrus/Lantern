// Analysis worker (spec §3): one job at a time; the face detector and the depth session stay resident. Jobs carry an ImageBitmap
// (transferred) and return results plus derived files as blobs. The main thread owns the queue.
import { basics } from "$lib/analysis/basics";
import { saliency } from "$lib/analysis/saliency";
import { detectFaces, loadFaceDetector, unloadFaceDetector } from "$lib/analysis/faces";
import { estimateDepth, loadDepth, unloadDepth } from "$lib/analysis/depth";
import { decodePlanes, depthStats, encodeDepth, encodePlanes, normalizeDepth, probeGrid, reliefOf } from "$lib/analysis/depthmath";
import { buildLayers } from "$lib/analysis/layers";
import { FILL_ATTEMPTS, fillPlate, loadFill, peopleKeepOut, peopleMask, unloadFill } from "$lib/analysis/fill";
import { detectPersons, loadPersonDetector, loadSegmenter, segmentPeople, unloadPersonDetector, unloadSegmenter } from "$lib/analysis/persons";
import type { Box } from "$lib/planner/types";
import { ANALYSIS_EDGE, PROXY_EDGE, THUMB_EDGE, encodeWebp, resizeBitmap } from "$lib/media/decode";

export type Job =
  | { id: number; kind: "basics"; bitmap: ImageBitmap; srcW: number; srcH: number; outHeight: number; name: string; makeProxies: boolean }
  | { id: number; kind: "faces"; bitmap: ImageBitmap; srcW: number; srcH: number; base: string }
  | { id: number; kind: "depth"; bitmap: ImageBitmap; srcW: number; srcH: number; base: string; edge: number; subject: Box | null; faces?: Box[]; people?: { mask: Uint8Array; w: number; h: number } | null; threads: boolean }
  | { id: number; kind: "segment"; bitmap: ImageBitmap; base: string }
  | { id: number; kind: "persons"; bitmap: ImageBitmap; srcW: number; srcH: number; base: string }
  | { id: number; kind: "fill"; bitmap: ImageBitmap; matte: Blob; base: string; threads: boolean; people: { box: Box; score: number }[]; peopleMask: Blob | null; srcW: number; srcH: number; attempt: number }
  | { id: number; kind: "unload" };

/** Tell the queue the job's model is loaded and the work itself starts (for the progress panel). */
const ready = (id: number) => self.postMessage({ id, ready: true });

self.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.kind === "unload") { unloadFaceDetector(); unloadPersonDetector(); unloadSegmenter(); await unloadDepth(); await unloadFill(); self.postMessage({ id: job.id, result: null }); return; }
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
      ready(job.id);
      const scale = job.srcW / job.bitmap.width;
      const faces = await detectFaces(det, job.bitmap, scale);
      job.bitmap.close();
      self.postMessage({ id: job.id, result: { faces } });
      return;
    }
    if (job.kind === "depth") {
      const s = await loadDepth(job.base, job.threads, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      ready(job.id);
      const t0 = performance.now();
      const { raw, w, h, px } = await estimateDepth(s, job.bitmap, job.edge);
      job.bitmap.close();
      const norm = normalizeDepth(raw);
      const stats = depthStats(norm.u16, w, h, { lo: norm.lo, hi: norm.hi, cv: reliefOf(raw) }, job.subject, job.srcW, job.srcH);
      const inference = performance.now() - t0;
      // Layers: subject matte, background plate and its depth (spec §4.6), from the map alone.
      const sx = w / job.srcW, sy = h / job.srcH;
      const subj = job.subject ? ([job.subject[0] * sx, job.subject[1] * sy, job.subject[2] * sx, job.subject[3] * sy] as Box) : null;
      const people = job.people ? resample01(job.people.mask, job.people.w, job.people.h, w, h) : null;
      const layers = buildLayers(px, norm.u16, w, h, subj, stats.pivot, stats.pivot - stats.sep, (job.faces ?? []).map((f) => [f[0] * sx, f[1] * sy, f[2] * sx, f[3] * sy] as Box), people);
      stats.grid = probeGrid(layers.bgDepth, w, h);
      const [file, bgFile] = await Promise.all([encodeDepth(norm.u16, w, h), encodeDepth(layers.bgDepth, w, h)]);
      let matteFile: Blob | null = null, plateFile: Blob | null = null;
      const peopleFile = people ? await encodePlanes([people], w, h) : null;
      if (layers.matte && layers.plate) {
        matteFile = await encodePlanes([layers.tight, layers.grown], w, h);
        const c = new OffscreenCanvas(w, h);
        c.getContext("2d")!.putImageData(new ImageData(layers.plate, w, h), 0, 0);
        plateFile = await c.convertToBlob({ type: "image/webp", quality: 0.9 });
        stats.sep = layers.matte.sep; stats.pivot = layers.matte.pivot;
      }
      const depth = { ...stats, matte: layers.matte ? { tau: layers.matte.tau, cover: layers.matte.cover, box: [layers.matte.box[0] / sx, layers.matte.box[1] / sy, layers.matte.box[2] / sx, layers.matte.box[3] / sy] as Box } : undefined };
      self.postMessage({ id: job.id, result: { depth, file, bgFile, matteFile, plateFile, peopleFile, ms: inference, layersMs: performance.now() - t0 - inference } });
      return;
    }
    if (job.kind === "segment") {
      const seg = await loadSegmenter(job.base, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      ready(job.id);
      const r = segmentPeople(seg, job.bitmap);
      job.bitmap.close();
      self.postMessage({ id: job.id, result: r }, { transfer: [r.mask.buffer] });
      return;
    }
    if (job.kind === "persons") {
      const det = await loadPersonDetector(job.base, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      ready(job.id);
      const persons = detectPersons(det, job.bitmap, job.srcW / job.bitmap.width);
      job.bitmap.close();
      self.postMessage({ id: job.id, result: { persons } });
      return;
    }
    if (job.kind === "fill") {
      const s = await loadFill(job.base, job.threads, (done, total) => self.postMessage({ id: job.id, progress: total ? done / total : 0 }));
      ready(job.id);
      const m = await decodePlanes(job.matte), w = m.w, h = m.h;
      const c = new OffscreenCanvas(w, h), g = c.getContext("2d")!;
      g.drawImage(job.bitmap, 0, 0, w, h);
      job.bitmap.close();
      const px = g.getImageData(0, 0, w, h).data;
      // The hole is where the grown matte is fully on (the classical plate's hole plus its 2 px edge).
      const hole = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) hole[i] = m.planes[1][i] >= 250 ? 1 : 0;
      const t0 = performance.now();
      const sx = w / job.srcW, sy = h / job.srcH;
      const people = job.people.map((p) => ({ score: p.score, box: [p.box[0] * sx, p.box[1] * sy, p.box[2] * sx, p.box[3] * sy] as Box }));
      // Hide people the hole touches: by their mask when the depth stage made one, else by their boxes.
      const pm = job.peopleMask ? await decodePlanes(job.peopleMask) : null;
      const keepOut = pm && pm.w === w && pm.h === h ? peopleKeepOut(pm.planes[0], hole, w, h) : peopleMask(people, hole, w, h);
      const r = await fillPlate(s, px, hole, w, h, keepOut, FILL_ATTEMPTS[job.attempt]);
      const ms = performance.now() - t0;
      if (!r) { self.postMessage({ id: job.id, result: { plateFile: null, guard: null, generated: hole, w, h, ms } }, { transfer: [hole.buffer] }); return; }
      g.putImageData(new ImageData(r.plate, w, h), 0, 0);
      const plateFile = await c.convertToBlob({ type: "image/webp", quality: 0.9 });
      const guard = await createImageBitmap(new ImageData(r.composite, w, h));
      self.postMessage({ id: job.id, result: { plateFile, guard, generated: r.generated, w, h, ms } }, { transfer: [guard, r.generated.buffer] });
      return;
    }
  } catch (err) {
    self.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
};

/** A 0/1 mask resampled bilinearly to another size, as 0–255 (soft edges). */
function resample01(m: Uint8Array, mw: number, mh: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * mh / h - 0.5)), y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mw / w - 0.5)), x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
      const v = (m[y0 * mw + x0] * (1 - tx) + m[y0 * mw + x1] * tx) * (1 - ty) + (m[y1 * mw + x0] * (1 - tx) + m[y1 * mw + x1] * tx) * ty;
      out[y * w + x] = Math.round(v * 255);
    }
  }
  return out;
}
