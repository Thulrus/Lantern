import { describe, expect, it } from "vitest";
import { DEPTH_GRID, decodeDepth, depthProbe, depthStats, encodeDepth, normalizeDepth, reliefOf, subjectRegion } from "./depthmath";

// A synthetic scene: a near "person" (high disparity) on the left half, a far background.
function scene(w: number, h: number, near = 8, far = 2): Float32Array {
  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = x < w * 0.4 && y > h * 0.2 ? near : far + (y / h) * 0.5;
  return raw;
}

describe("depth maths", () => {
  it("normalises by percentiles and keeps order", () => {
    const raw = scene(70, 42);
    const { u16, lo, hi } = normalizeDepth(raw);
    expect(lo).toBeLessThan(hi);
    expect(u16[41 * 70 + 5]).toBe(65535);                 // near subject → 1
    expect(u16[0]).toBeLessThan(2000);                     // far background top → ~0
  });

  it("measures subject separation, pivot and relief", () => {
    const w = 70, h = 42, raw = scene(w, h);
    const norm = normalizeDepth(raw);
    const stats = depthStats(norm.u16, w, h, { lo: norm.lo, hi: norm.hi, cv: reliefOf(raw) }, [0, 0.2 * 1000, 0.4 * 1000, 1000], 1000, 1000);
    expect(stats.sep).toBeGreaterThan(0.7);
    expect(stats.pivot).toBeGreaterThan(0.9);
    expect(stats.quality).toBeGreaterThan(0.9);
    expect(stats.grid.length).toBe(DEPTH_GRID * DEPTH_GRID);
    const probe = depthProbe(stats);
    expect(probe(0.1, 0.9, false)).toBeGreaterThan(0.9);
    expect(probe(0.9, 0.1, false)).toBeLessThan(0.2);
  });

  it("calls a flat scene low quality with no separation", () => {
    const w = 56, h = 56, raw = new Float32Array(w * h).fill(5);
    for (let i = 0; i < raw.length; i++) raw[i] += ((i * 7919) % 13) * 0.002;   // sensor-like noise
    const norm = normalizeDepth(raw);
    const stats = depthStats(norm.u16, w, h, { lo: norm.lo, hi: norm.hi, cv: reliefOf(raw) }, null, 560, 560);
    expect(stats.quality).toBeLessThan(0.05);
    expect(stats.sep).toBe(0);
  });

  it("grows faces into a head-and-shoulders subject, else uses the first point of interest", () => {
    const s = subjectRegion([[100, 100, 140, 140]], [], 1000, 1000)!;
    expect(s[0]).toBeLessThan(100); expect(s[3]).toBeGreaterThan(200); expect(s[3]).toBeLessThanOrEqual(1000);
    expect(subjectRegion([], [[1, 2, 3, 4]], 10, 10)).toEqual([1, 2, 3, 4]);
    expect(subjectRegion([], [], 10, 10)).toBeNull();
  });

  it("round-trips the gzip file format", async () => {
    const w = 28, h = 14, u16 = new Uint16Array(w * h).map((_, i) => (i * 1237) % 65536);
    const blob = await encodeDepth(u16, w, h);
    expect(blob.size).toBeLessThan(8 + w * h * 2 + 64);
    const d = await decodeDepth(blob);
    expect(d.w).toBe(w); expect(d.h).toBe(h);
    expect(Array.from(d.u16)).toEqual(Array.from(u16));
  });
});
