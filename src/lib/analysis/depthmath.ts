// Depth map maths with no model dependency (unit-tested in Node): normalisation of a raw
// relative-disparity map to 16 bits, the planner's depth statistics (subject separation, pivot,
// quality), a coarse probe grid, and the on-disk format of /m/<hash>/depth.u16.gz (spec §8.1).
import type { Box, DepthInfo } from "$lib/planner/types";

export const DEPTH_GRID = 32;
const MAGIC = 0x4c445031; // "LDP1": little-endian u32 magic, u16 width, u16 height, then u16 samples.

function quantile(sorted: Float32Array, q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Map raw disparity (bigger = nearer, arbitrary scale) to inverse depth in [0, 1] as u16: the
 *  1st and 99th percentiles become 0 and 1, so one stray pixel cannot flatten the scene. */
export function normalizeDepth(raw: Float32Array): { u16: Uint16Array; lo: number; hi: number } {
  const sorted = Float32Array.from(raw).sort();
  const lo = quantile(sorted, 0.01), hi = quantile(sorted, 0.99);
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const u16 = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) u16[i] = Math.max(0, Math.min(65535, Math.round(((raw[i] - lo) / span) * 65535)));
  return { u16, lo, hi };
}

/** The subject region in source pixels: the faces grown to a head-and-shoulders box, else the
 *  strongest point of interest, else nothing. */
export function subjectRegion(faces: Box[], pois: Box[], w: number, h: number): Box | null {
  if (faces.length) {
    let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of faces) {
      const s = Math.max(f[2] - f[0], f[3] - f[1]);
      b = [Math.min(b[0], f[0] - 0.6 * s), Math.min(b[1], f[1] - 0.5 * s), Math.max(b[2], f[2] + 0.6 * s), Math.max(b[3], f[3] + 2.5 * s)];
    }
    return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])];
  }
  return pois[0] ?? null;
}

/** Planner statistics from a normalised map. `subject` is in source pixels (srcW × srcH). */
export function depthStats(u16: Uint16Array, w: number, h: number, raw: { lo: number; hi: number; cv: number }, subject: Box | null, srcW: number, srcH: number): Omit<DepthInfo, "available"> {
  const inside: number[] = [], outside: number[] = [];
  const sx = w / srcW, sy = h / srcH;
  const sb = subject ? [Math.floor(subject[0] * sx), Math.floor(subject[1] * sy), Math.ceil(subject[2] * sx), Math.ceil(subject[3] * sy)] : null;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const v = u16[y * w + x] / 65535;
      if (sb && x >= sb[0] && x < sb[2] && y >= sb[1] && y < sb[3]) inside.push(v); else outside.push(v);
    }
  const med = (a: number[]) => { if (!a.length) return 0.5; const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };
  const all = med([...inside, ...outside]);
  const subjectMedian = inside.length ? med(inside) : all;
  const sep = sb && inside.length && outside.length ? subjectMedian - med(outside) : 0;
  // Quality [verify]: how much relief the raw map has (coefficient of variation of the raw
  // disparity); a wall or a document comes out flat and gets no 3D treatment.
  const quality = Math.max(0, Math.min(1, raw.cv / 0.3));
  // Probe grid: box averages, 8-bit, row-major, for the planner's border clamp.
  const gw = DEPTH_GRID, gh = DEPTH_GRID, grid: number[] = new Array(gw * gh).fill(0);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      const y0 = Math.floor((gy * h) / gh), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += u16[y * w + x]; n++; }
      grid[gy * gw + gx] = Math.round((sum / Math.max(1, n)) / 257);
    }
  return { w, h, sep, pivot: subjectMedian, quality, range: [raw.lo, raw.hi], grid, gridW: gw, gridH: gh };
}

/** Coefficient of variation of the raw disparity, the relief measure behind `quality`. */
export function reliefOf(raw: Float32Array): number {
  let s = 0, s2 = 0;
  for (let i = 0; i < raw.length; i++) { s += raw[i]; s2 += raw[i] * raw[i]; }
  const mean = s / raw.length, v = Math.max(0, s2 / raw.length - mean * mean);
  return mean > 1e-6 ? Math.sqrt(v) / mean : 0;
}

/** A probe over the coarse grid for the camera border clamp: (fx, fy) in [0, 1] of the image. */
export function depthProbe(d: Pick<DepthInfo, "grid" | "gridW" | "gridH">): (fx: number, fy: number, fig: boolean) => number {
  return (fx, fy) => {
    const gx = Math.min(d.gridW - 1, Math.max(0, Math.floor(fx * d.gridW)));
    const gy = Math.min(d.gridH - 1, Math.max(0, Math.floor(fy * d.gridH)));
    return (d.grid[gy * d.gridW + gx] ?? 128) / 255;
  };
}

/** Serialise a map as gzip(header + u16 samples). */
export async function encodeDepth(u16: Uint16Array, w: number, h: number): Promise<Blob> {
  const head = new DataView(new ArrayBuffer(8));
  head.setUint32(0, MAGIC, true); head.setUint16(4, w, true); head.setUint16(6, h, true);
  const body = new Uint8Array(8 + u16.byteLength);
  body.set(new Uint8Array(head.buffer), 0);
  body.set(new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength), 8);
  const gz = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(gz).blob();
}

export async function decodeDepth(blob: Blob): Promise<{ w: number; h: number; u16: Uint16Array }> {
  const buf = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error("not a Lantern depth file");
  const w = dv.getUint16(4, true), h = dv.getUint16(6, true);
  if (buf.byteLength !== 8 + w * h * 2) throw new Error("depth file size mismatch");
  return { w, h, u16: new Uint16Array(buf.slice(8)) };
}

/** The renderer's maps texture (spec §9.1): R and G carry the depth (one layer until mattes
 *  exist), B and A the subject alpha (none yet, so the subject layer is empty). */
export function mapsImage(u16: Uint16Array, w: number, h: number): ImageData {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < u16.length; i++, j += 4) { const d = u16[i] >> 8; px[j] = d; px[j + 1] = d; px[j + 2] = 0; px[j + 3] = 0; }
  return new ImageData(px, w, h);
}
