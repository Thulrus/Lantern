import { describe, expect, it } from "vitest";
import { inpaint } from "./inpaint";
import { pullPush } from "./layers";

/** Diagonal stripes (period 12) with a hole in the middle. */
function scene(w: number, h: number, hx0: number, hy0: number, hx1: number, hy1: number) {
  const n = w * h, truth = new Float32Array(n), hole = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    truth[y * w + x] = (x + y) % 12 < 6 ? 220 : 40;
    hole[y * w + x] = x >= hx0 && x < hx1 && y >= hy0 && y < hy1 ? 1 : 0;
  }
  return { truth, hole };
}

const err = (a: Float32Array, b: Float32Array, hole: Uint8Array) => {
  let e = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (hole[i]) { e += Math.abs(a[i] - b[i]); k++; }
  return e / k;
};

describe("inpaint", () => {
  it("continues a texture through the hole far better than pull-push", () => {
    const W = 160, H = 120, { truth, hole } = scene(W, H, 60, 40, 100, 80);
    const pp = truth.slice(), known = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) known[i] = hole[i] ? 0 : 1;
    pullPush([pp], known, W, H);
    const ip = pp.slice();
    expect(inpaint([ip], hole, W, H)).toBe(true);
    const ePP = err(pp, truth, hole), eIP = err(ip, truth, hole);
    expect(eIP).toBeLessThan(ePP * 0.5);
    for (let i = 0; i < W * H; i++) if (!hole[i]) expect(ip[i]).toBe(truth[i]);
  });

  it("never copies from avoided pixels", () => {
    const W = 120, H = 90, n = W * H, img = new Float32Array(n), hole = new Uint8Array(n), avoid = new Uint8Array(n);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      img[i] = x < 30 ? 255 : 100;          // a bright "face" strip on the left, avoided
      avoid[i] = x < 30 ? 1 : 0;
      hole[i] = x >= 40 && x < 60 && y >= 30 && y < 60 ? 1 : 0;
    }
    for (let i = 0; i < n; i++) if (hole[i]) img[i] = 180;
    inpaint([img], hole, W, H, avoid);
    for (let i = 0; i < n; i++) if (hole[i]) expect(img[i]).toBeCloseTo(100, 0);
  });

  it("returns false when nothing is known enough to copy", () => {
    const W = 40, H = 40, img = new Float32Array(W * H), hole = new Uint8Array(W * H).fill(1);
    expect(inpaint([img], hole, W, H)).toBe(false);
  });

  it("fills a map-sized plate in reasonable time", () => {
    const W = 770, H = 518, { truth, hole } = scene(W, H, 250, 120, 500, 450);
    const ch = [truth.slice(), truth.slice(), truth.slice(), truth.slice()];
    const t0 = performance.now();
    inpaint(ch, hole, W, H);
    const ms = performance.now() - t0;
    console.log(`inpaint 770×518, ${(250 * 330 / (W * H) * 100).toFixed(0)} % hole: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(15000);
  }, 30000);
});
