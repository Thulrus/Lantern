// Saliency without a model (spec §4.3 fallback): spectral residual (Hou & Zhang 2007) on a 64 px
// grey image, then peak boxes by thresholding and connected components.
import type { Box, SaliencyResult } from "$lib/planner/types";
import { resampleGrey } from "./basics";

export const SALIENCY_VERSION = 1;
const N = 64;

function dft2(re: Float32Array, im: Float32Array, inverse: boolean): void {
  // Separable DFT on N×N (N small, so O(N^3) is fine: 64^3 = 262k complex ops per pass).
  const sgn = inverse ? 1 : -1;
  const cosT = new Float32Array(N * N), sinT = new Float32Array(N * N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) { cosT[k * N + n] = Math.cos((2 * Math.PI * k * n) / N); sinT[k * N + n] = sgn * Math.sin((2 * Math.PI * k * n) / N); }
  const tr = new Float32Array(N), ti = new Float32Array(N);
  for (let y = 0; y < N; y++) {
    for (let k = 0; k < N; k++) { let a = 0, b = 0; for (let n = 0; n < N; n++) { const r = re[y * N + n], i = im[y * N + n], c = cosT[k * N + n], s = sinT[k * N + n]; a += r * c - i * s; b += r * s + i * c; } tr[k] = a; ti[k] = b; }
    for (let k = 0; k < N; k++) { re[y * N + k] = tr[k]; im[y * N + k] = ti[k]; }
  }
  for (let x = 0; x < N; x++) {
    for (let k = 0; k < N; k++) { let a = 0, b = 0; for (let n = 0; n < N; n++) { const r = re[n * N + x], i = im[n * N + x], c = cosT[k * N + n], s = sinT[k * N + n]; a += r * c - i * s; b += r * s + i * c; } tr[k] = a; ti[k] = b; }
    for (let k = 0; k < N; k++) { re[k * N + x] = tr[k] / (inverse ? N * N : 1); im[k * N + x] = ti[k] / (inverse ? N * N : 1); }
  }
}

export function spectralResidual(grey: Float32Array, w: number, h: number): Float32Array {
  const g = resampleGrey(grey, w, h, N, N);
  const re = Float32Array.from(g), im = new Float32Array(N * N);
  dft2(re, im, false);
  const logAmp = new Float32Array(N * N), phase = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) { logAmp[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-6); phase[i] = Math.atan2(im[i], re[i]); }
  // Residual = log amplitude minus its 3×3 mean.
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = (y + dy + N) % N, xx = (x + dx + N) % N; s += logAmp[yy * N + xx]; n++; }
      const r = Math.exp(logAmp[y * N + x] - s / n);
      re[y * N + x] = r * Math.cos(phase[y * N + x]); im[y * N + x] = r * Math.sin(phase[y * N + x]);
    }
  dft2(re, im, true);
  const sal = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) sal[i] = re[i] * re[i] + im[i] * im[i];
  // Gaussian blur (5-tap, twice) and normalize; suppress the border a little (edges ring).
  const blurred = blur(blur(sal));
  let mx = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const e = Math.min(x, y, N - 1 - x, N - 1 - y); const k = Math.min(1, (e + 1) / 4); blurred[y * N + x] *= k; mx = Math.max(mx, blurred[y * N + x]); }
  for (let i = 0; i < N * N; i++) blurred[i] /= mx || 1;
  return blurred;
}

function blur(a: Float32Array): Float32Array {
  const k = [1, 4, 6, 4, 1], out = new Float32Array(N * N), tmp = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let d = -2; d <= 2; d++) s += k[d + 2] * a[y * N + Math.min(N - 1, Math.max(0, x + d))]; tmp[y * N + x] = s / 16; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let d = -2; d <= 2; d++) s += k[d + 2] * tmp[Math.min(N - 1, Math.max(0, y + d)) * N + x]; out[y * N + x] = s / 16; }
  return out;
}

/** Peak boxes: threshold at 55% of the max, connected components, boxes in source pixels. */
export function saliency(grey: Float32Array, w: number, h: number, srcW: number, srcH: number): SaliencyResult {
  const s = spectralResidual(grey, w, h);
  const thr = 0.55;
  const seen = new Uint8Array(N * N);
  const peaks: { box: Box; score: number }[] = [];
  let cx = 0, cy = 0, cm = 0;
  for (let i = 0; i < N * N; i++) { cx += (i % N) * s[i]; cy += Math.floor(i / N) * s[i]; cm += s[i]; }
  for (let i = 0; i < N * N; i++) {
    if (seen[i] || s[i] < thr) continue;
    const stack = [i]; seen[i] = 1;
    let x0 = N, y0 = N, x1 = 0, y1 = 0, score = 0, cnt = 0;
    while (stack.length) {
      const j = stack.pop()!, x = j % N, y = Math.floor(j / N);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); score += s[j]; cnt++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const k = yy * N + xx;
        if (!seen[k] && s[k] >= thr) { seen[k] = 1; stack.push(k); }
      }
    }
    if (cnt < 3) continue;
    const pad = 1.5;
    const box: Box = [Math.max(0, (x0 - pad) / N) * srcW, Math.max(0, (y0 - pad) / N) * srcH, Math.min(1, (x1 + 1 + pad) / N) * srcW, Math.min(1, (y1 + 1 + pad) / N) * srcH];
    peaks.push({ box, score: score / cnt });
  }
  peaks.sort((a, b) => b.score - a.score);
  return { peaks: peaks.slice(0, 6), center: cm ? [cx / cm / N, cy / cm / N] : [0.5, 0.5] };
}
