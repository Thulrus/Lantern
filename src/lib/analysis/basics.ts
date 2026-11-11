// Basics stage (spec §4.2): pHash, sharpness (variance of Laplacian on a fixed-size grey proxy),
// exposure and contrast, colourfulness, edge density and the quality flags (spec §4.5).
import type { BasicsResult, QualityFlag } from "$lib/planner/types";

export const BASICS_VERSION = 1;

/** Resample a grey image to w×h with box filtering. */
export function resampleGrey(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += src[yy * sw + xx]; n++; }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/** 64-bit perceptual hash: DCT of a 32×32 grey image, the top-left 8×8 (minus DC) against the median. */
export function phash(grey: Float32Array, w: number, h: number): string {
  const N = 32;
  const g = resampleGrey(grey, w, h, N, N);
  const cosT: number[][] = [];
  for (let u = 0; u < 8; u++) { cosT.push([]); for (let x = 0; x < N; x++) cosT[u].push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))); }
  const rows: number[][] = [];
  for (let y = 0; y < N; y++) { const r: number[] = []; for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < N; x++) s += g[y * N + x] * cosT[u][x]; r.push(s); } rows.push(r); }
  const d: number[] = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let s = 0; for (let y = 0; y < N; y++) s += rows[y][u] * cosT[v][y]; d.push(s); }
  const ac = d.slice(1);
  const sorted = [...ac].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  let bits = "";
  for (let i = 0; i < 64; i++) bits += i === 0 ? "0" : d[i] > med ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function laplacianVariance(g: Float32Array, w: number, h: number): number {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += l; s2 += l * l; n++;
    }
  const m = s / Math.max(1, n);
  return s2 / Math.max(1, n) - m * m;
}

export function basics(data: Uint8ClampedArray, w: number, h: number, srcW: number, srcH: number, outHeight: number, name: string): BasicsResult {
  const grey = new Float32Array(w * h);
  let rg = 0, yb = 0, rg2 = 0, yb2 = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    grey[j] = 0.299 * r + 0.587 * g + 0.114 * b;
    const a = r - g, c = 0.5 * (r + g) - b;
    rg += a; rg2 += a * a; yb += c; yb2 += c * c;
  }
  const n = w * h;
  const mrg = rg / n, myb = yb / n;
  const srg = Math.sqrt(Math.max(0, rg2 / n - mrg * mrg)), syb = Math.sqrt(Math.max(0, yb2 / n - myb * myb));
  const colorfulness = Math.sqrt(srg * srg + syb * syb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);
  // Fixed-size proxy for sharpness so the number is comparable across resolutions.
  const S = 256, k = S / Math.max(w, h);
  const sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(h * k));
  const small = resampleGrey(grey, w, h, sw, sh);
  const sharpness = laplacianVariance(small, sw, sh);
  let sum = 0, sum2 = 0, dark = 0, bright = 0, edges = 0;
  for (let i = 0; i < n; i++) { const v = grey[i] / 255; sum += v; sum2 += v * v; if (v < 0.04) dark++; if (v > 0.97) bright++; }
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) { const i = y * sw + x; if (Math.abs(small[i + 1] - small[i - 1]) + Math.abs(small[i + sw] - small[i - sw]) > 40) edges++; }
  const exposure = sum / n, contrast = Math.sqrt(Math.max(0, sum2 / n - exposure * exposure));
  const edgeDensity = edges / ((sw - 2) * (sh - 2));
  const clipped = { dark: dark / n, bright: bright / n };
  const flags: QualityFlag[] = [];
  if (sharpness < 25) flags.push("blurry");
  if (exposure < 0.12 && clipped.dark > 0.4) flags.push("dark");
  if (clipped.bright > 0.25) flags.push("blown");
  if (srcH < outHeight / 1.25 && srcW < (outHeight * 16) / 9 / 1.25) flags.push("tiny");
  // Screenshot heuristic: very low colourfulness or a flat histogram with many exact repeats, plus a screen-like size.
  const hist = new Uint32Array(64);
  for (let i = 0; i < n; i++) hist[Math.min(63, grey[i] >> 2)]++;
  let top = 0; for (const c of hist) top = Math.max(top, c);
  const screenish = /screen|shot|capture/i.test(name) || ([1080, 1440, 2160, 2340, 2532, 2556, 2778, 2796].includes(srcH) && [1920, 2560, 3840, 1080, 1170, 1179, 1284, 1290].includes(srcW));
  if ((top / n > 0.35 && colorfulness < 25) || (screenish && edgeDensity > 0.12 && top / n > 0.2)) flags.push("screenshot");
  return { phash: phash(grey, w, h), sharpness, exposure, contrast, colorfulness, edgeDensity, clipped, flags };
}
