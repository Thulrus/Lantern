export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Smoothstep easing on [0, 1]. The planner and renderer share it (spec §9.1). */
export const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
export const round = (x: number, p = 5) => { const k = 10 ** p; return Math.round(x * k) / k; };
export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = clamp((s.length - 1) * p, 0, s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return lerp(s[lo], s[hi], i - lo);
};
export const mean = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : 0;
};
export const sum = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
};
export type Box = [number, number, number, number]; // x0, y0, x1, y1
export const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
export const iou = (a: Box, b: Box) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / Math.max(area(a) + area(b) - inter, 1e-9);
};
export const fmtTime = (s: number): string => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
};
export const fmtClock = (s: number): string => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
};
export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
