// Generative background fill (spec §1.2, §4.6, M6): LaMa (Apache-2.0, big-lama, ONNX export by
// Carve, fixed 512 × 512) fills the hole behind the subject so parallax reveals a plausible
// background instead of a blurred rim. Runs in the analysis worker on ONNX Runtime Web. Inputs
// `image` f32 [1,3,512,512] in 0–1 with hole pixels zeroed, `mask` f32 [1,1,512,512] with 1 = fill;
// output `output` f32 [1,3,512,512] in 0–255 (verified 2026-11-14). MI-GAN was tried first and
// rejected: on person-sized holes it paints dark figure-like blobs. Only hole pixels are taken from
// the result; the person guard (in the queue) rejects plates in which a face or a new person shows.
import * as ort from "onnxruntime-web/wasm";
import { fetchModel } from "$lib/models/fetch";
import { configureOrt } from "./depth";
import { iou } from "$lib/util/math";
import type { Box } from "$lib/planner/types";

export const FILL_MODEL = "lama-512";
export const FILL_VERSION = 3;   // 3: LaMa
const PAD = 0.2;          // context around the hole's box, share of its long side
const MIN_PAD = 24;       // px at map size
const SIDE = 512;         // the export's fixed input size
/** Attempts, in order, until one passes the person guard: later ones give more context around the
 *  hole (pad, share of the hole's long side), which changes what the model paints. */
export const FILL_ATTEMPTS = [{ pad: 0.25 }, { pad: 0.6 }, { pad: 1.2 }];
const CUT_MAX = 0.6;      // a person box with less than this share inside the hole is "cut" by it (0.95 hid whole groups and starved the model)
const CONTEXT_MIN_LOSS = 0.5; // hiding cut people may take at most this share of the known pixels

let session: ort.InferenceSession | null = null;
let loading: Promise<ort.InferenceSession> | null = null;

export async function loadFill(base: string, threads: boolean, onProgress?: (done: number, total: number) => void): Promise<ort.InferenceSession> {
  if (session) return session;
  loading ??= (async () => {
    configureOrt(base, threads);
    const buf = await fetchModel(FILL_MODEL, onProgress);
    session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return session;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}

export async function unloadFill(): Promise<void> {
  if (session) await session.release();
  session = null; loading = null;
}

/** The crop to fill: the hole's bounding box plus context, made square where the frame allows
 *  (the model works on a 512² square), shifted to stay inside the frame. Null when there is no hole. */
export function fillCrop(hole: Uint8Array, w: number, h: number, padShare = PAD): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, pad = Math.max(MIN_PAD, padShare * Math.max(bw, bh));
  const side = Math.round(Math.max(bw, bh) + 2 * pad);
  const cw = Math.min(w, side), ch = Math.min(h, side);
  const cx = Math.round(Math.min(Math.max(0, (x0 + x1) / 2 - cw / 2), w - cw));
  const cy = Math.round(Math.min(Math.max(0, (y0 + y1) / 2 - ch / 2), h - ch));
  return [cx, cy, cw, ch];
}

/** People whose box (grown 10 %) touches the hole: their pixels are hidden from the model, so it
 *  fills the hole with background instead of continuing a body the hole cuts through (spec §1.2). */
export function peopleMask(people: { box: Box; score: number }[], hole: Uint8Array, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const p of people) {
    if (p.score < 0.3) continue;
    const g = 0.1 * Math.max(p.box[2] - p.box[0], p.box[3] - p.box[1]);
    const x0 = Math.max(0, Math.floor(p.box[0] - g)), y0 = Math.max(0, Math.floor(p.box[1] - g));
    const x1 = Math.min(w, Math.ceil(p.box[2] + g)), y1 = Math.min(h, Math.ceil(p.box[3] + g));
    // Only people the hole cuts through; someone mostly inside it is already hidden.
    const share = insideShare([x0, y0, x1, y1], hole, w, h);
    if (share > 0 && share < CUT_MAX) for (let y = y0; y < y1; y++) m.fill(1, y * w + x0, y * w + x1);
  }
  return m;
}

/** From the person mask (0–255, map size): the person pixels outside the hole in every blob that
 *  touches it, grown by 3 px. Hidden from the model so it cannot continue those bodies. */
export function peopleKeepOut(people: Uint8Array, hole: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h, label = new Int32Array(n).fill(-1), touch: boolean[] = [], stack: number[] = [];
  let next = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (people[s0] < 96 || label[s0] >= 0) continue;
    label[s0] = next; stack.push(s0); touch[next] = false;
    while (stack.length) {
      const i = stack.pop()!, x = i % w;
      if (hole[i]) touch[next] = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n) continue;
        if (hole[j]) touch[next] = true;
        if (label[j] < 0 && people[j] >= 96) { label[j] = next; stack.push(j); }
      }
    }
    next++;
  }
  const m = new Uint8Array(n), r = 3;
  for (let i = 0; i < n; i++) {
    if (label[i] < 0 || !touch[label[i]] || hole[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && !hole[yy * w + xx]) m[yy * w + xx] = 1;
    }
  }
  return m;
}

/** Person guard, bodies part: a confident person box lying ≥ 25 % inside generated pixels that
 *  matches no person in the original photo (IoU ≥ 0.5) was invented by the fill. */
export function inventedPerson(found: { box: Box; score: number }[], original: { box: Box }[], hole: Uint8Array, w: number, h: number): boolean {
  // People cut out into the hole must not reappear in the plate, so they are no reference.
  const kept = original.filter((o) => insideShare(o.box, hole, w, h) < 0.5);
  return found.some((f) => f.score >= 0.5 && insideShare(f.box, hole, w, h) >= 0.25 && !kept.some((o) => iou(o.box, f.box) >= 0.5));
}

function insideShare(box: Box, hole: Uint8Array, w: number, h: number): number {
  const [x0, y0, x1, y1] = box.map(Math.round);
  let inside = 0, all = 0;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { all++; inside += hole[y * w + x]; }
  return all ? inside / all : 0;
}

/** Bilinear resample of a planar or interleaved image region (`C` channels per pixel). */
function resample(src: ArrayLike<number>, sw: number, sh: number, C: number, dw: number, dh: number, stride = sw, x0 = 0, y0 = 0): Float32Array {
  const out = new Float32Array(dw * dh * C);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5)), ya = Math.floor(fy), yb = Math.min(sh - 1, ya + 1), ty = fy - ya;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5)), xa = Math.floor(fx), xb = Math.min(sw - 1, xa + 1), tx = fx - xa;
      const i00 = ((y0 + ya) * stride + x0 + xa) * C, i01 = ((y0 + ya) * stride + x0 + xb) * C, i10 = ((y0 + yb) * stride + x0 + xa) * C, i11 = ((y0 + yb) * stride + x0 + xb) * C;
      for (let c = 0; c < C; c++)
        out[(y * dw + x) * C + c] = (src[i00 + c] * (1 - tx) + src[i01 + c] * tx) * (1 - ty) + (src[i10 + c] * (1 - tx) + src[i11 + c] * tx) * ty;
    }
  }
  return out;
}

/** Fill the hole of `px` (RGBA, map size): a square crop around it (plus `attempt.pad` context) is
 *  scaled to 512², filled, and scaled back; only hole pixels are kept. People in `keepOut` are
 *  hidden from the model too. Returns the plate (alpha 255 over the hole), the composite for the
 *  guard, and the generated pixels (the hole). */
export async function fillPlate(s: ort.InferenceSession, px: Uint8ClampedArray, hole: Uint8Array, w: number, h: number, keepOut?: Uint8Array, attempt = FILL_ATTEMPTS[0]): Promise<{ plate: Uint8ClampedArray<ArrayBuffer>; composite: Uint8ClampedArray<ArrayBuffer>; generated: Uint8Array<ArrayBuffer> } | null> {
  const n0 = w * h;
  const crop = fillCrop(hole, w, h, attempt.pad);
  if (!crop) return null;
  const [cx, cy, cw, ch] = crop;
  // Too little context left in the crop after hiding people: hide nobody and let the guard judge.
  if (keepOut) {
    let hidden = 0, known = 0;
    for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) { const j = y * w + x; if (!hole[j]) { known++; hidden += keepOut[j]; } }
    if (hidden > CONTEXT_MIN_LOSS * known) keepOut = undefined;
  }
  const masked = new Uint8Array(n0);
  for (let j = 0; j < n0; j++) masked[j] = hole[j] || keepOut?.[j] ? 1 : 0;
  const N = SIDE * SIDE;
  const rgbC = resample(px, cw, ch, 4, SIDE, SIDE, w, cx, cy), mC = resample(masked, cw, ch, 1, SIDE, SIDE, w, cx, cy);
  const img = new Float32Array(3 * N), mask = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const hole1 = mC[i] > 0.01 ? 1 : 0;   // any coverage counts as hole, so no person pixel survives the scaling
    mask[i] = hole1;
    for (let c = 0; c < 3; c++) img[c * N + i] = hole1 ? 0 : rgbC[i * 4 + c] / 255;
  }
  const r = await s.run({ image: new ort.Tensor("float32", img, [1, 3, SIDE, SIDE]), mask: new ort.Tensor("float32", mask, [1, 1, SIDE, SIDE]) });
  const o = r.output.data as Float32Array, inter = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) inter[i * 3 + c] = o[c * N + i];
  const back = resample(inter, SIDE, SIDE, 3, cw, ch);
  const composite = new Uint8ClampedArray(new ArrayBuffer(n0 * 4));
  composite.set(px);
  const plate = new Uint8ClampedArray(new ArrayBuffer(n0 * 4));
  plate.set(px);
  const gen = new Uint8Array(new ArrayBuffer(n0));
  for (let j = 0; j < n0; j++) plate[j * 4 + 3] = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const j = (cy + y) * w + cx + x;
    if (!hole[j]) continue;
    gen[j] = 1;
    for (let c = 0; c < 3; c++) composite[j * 4 + c] = plate[j * 4 + c] = back[(y * cw + x) * 3 + c];
    plate[j * 4 + 3] = 255;
  }
  return { plate, composite, generated: gen };
}

/** Person guard (spec §4.6), faces part: a confident face lying ≥ 25 % inside generated pixels is
 *  invented (the subject's own faces are inside the hole, so the plate must not show any). */
export function inventedFace(faces: { box: Box; score: number }[], hole: Uint8Array, w: number, h: number, maxSide = Infinity): boolean {
  return faces.some((f) => f.score >= 0.5 && Math.max(f.box[2] - f.box[0], f.box[3] - f.box[1]) <= maxSide && insideShare(f.box, hole, w, h) >= 0.25);
}

/** Largest plausible face on a plate: an invented face is drawn at the scene's scale, so detections
 *  far larger than any real face in the photo are texture (a 378 px "face" on fence posts, where
 *  the real faces were 40 px). With no real faces, 40 % of the short edge. */
export function faceLimit(originalSides: number[], w: number, h: number): number {
  const big = Math.max(0, ...originalSides);
  return big > 0 ? Math.max(2 * big, 0.15 * Math.min(w, h)) : 0.4 * Math.min(w, h);
}
