import { describe, expect, it } from "vitest";
import { fillCrop, inventedFace } from "./fill";

const holeBox = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
};

describe("fill", () => {
  it("crops a square around the hole, inside the frame", () => {
    const W = 770, H = 518, c = fillCrop(holeBox(W, H, 300, 200, 400, 300), W, H)!;
    expect(c[2]).toBe(c[3]);
    expect(c[0]).toBeLessThanOrEqual(300); expect(c[0] + c[2]).toBeGreaterThanOrEqual(400);
    const edge = fillCrop(holeBox(W, H, 700, 0, 770, 500), W, H)!;
    expect(edge[0] + edge[2]).toBeLessThanOrEqual(W); expect(edge[1]).toBeGreaterThanOrEqual(0);
    expect(edge[3]).toBeLessThanOrEqual(H);
    expect(fillCrop(new Uint8Array(W * H), W, H)).toBeNull();
  });

  it("flags a confident face lying in generated pixels", () => {
    const W = 100, H = 100, hole = holeBox(W, H, 20, 20, 60, 60);
    expect(inventedFace([{ box: [30, 30, 50, 50], score: 0.9 }], hole, W, H)).toBe(true);
    expect(inventedFace([{ box: [30, 30, 50, 50], score: 0.3 }], hole, W, H)).toBe(false);
    expect(inventedFace([{ box: [70, 70, 90, 90], score: 0.9 }], hole, W, H)).toBe(false);
  });
});

describe("person guard", () => {
  const W = 100, H = 100, hole = holeBox(W, H, 20, 20, 60, 60);
  it("hides only people the hole cuts through from the model", async () => {
    const { peopleMask } = await import("./fill");
    const m = peopleMask([{ box: [50, 30, 70, 90], score: 0.8 }, { box: [80, 80, 95, 95], score: 0.8 }], hole, W, H);
    expect(m[50 * W + 65]).toBe(1);
    expect(m[90 * W + 90]).toBe(0);
  });
  it("rejects a new person in generated pixels, accepts a real one at the edge", async () => {
    const { inventedPerson } = await import("./fill");
    const real = { box: [50, 30, 80, 90] as [number, number, number, number] };
    expect(inventedPerson([{ box: [25, 25, 45, 55], score: 0.8 }], [real], hole, W, H)).toBe(true);
    expect(inventedPerson([{ box: [51, 31, 80, 90], score: 0.8 }], [real], hole, W, H)).toBe(false);
    // A cut-out subject regenerated in place is still invented.
    expect(inventedPerson([{ box: [22, 22, 58, 58], score: 0.8 }], [{ box: [21, 21, 59, 59] }], hole, W, H)).toBe(true);
  });
});

describe("people keep-out", () => {
  it("hides the outside part of people touching the hole, not others", async () => {
    const { peopleKeepOut } = await import("./fill");
    const W = 100, H = 100, hole = holeBox(W, H, 20, 20, 60, 60), p = new Uint8Array(W * H);
    for (let y = 30; y < 90; y++) for (let x = 50; x < 70; x++) p[y * W + x] = 255;   // cut by the hole
    for (let y = 80; y < 95; y++) for (let x = 85; x < 95; x++) p[y * W + x] = 255;   // apart
    const m = peopleKeepOut(p, hole, W, H);
    expect(m[70 * W + 60]).toBe(1);
    expect(m[40 * W + 55]).toBe(0);   // inside the hole: the hole itself
    expect(m[90 * W + 90]).toBe(0);
  });
});

describe("face scale", () => {
  it("ignores face-sized texture far larger than the real faces", async () => {
    const { faceLimit, inventedFace } = await import("./fill");
    const W = 770, H = 518, hole = holeBox(W, H, 100, 0, 600, 518);
    const big = [{ box: [136, 0, 514, 378] as [number, number, number, number], score: 0.6 }];
    expect(inventedFace(big, hole, W, H, faceLimit([40, 38], W, H))).toBe(false);
    expect(inventedFace([{ box: [300, 200, 340, 240], score: 0.8 }], hole, W, H, faceLimit([40], W, H))).toBe(true);
  });
});
