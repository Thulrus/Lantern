import { describe, expect, it } from "vitest";
import { buildLayers, composeMaps, distanceOutside, gaussianBlur, otsu, pullPush, subjectThreshold } from "./layers";

// A synthetic scene at map size: a near rectangular "subject" (inverse depth 0.85) in the middle
// of a far room (0.2 at the top ramping to 0.35 at the bottom). The photo is grey where the
// subject is and a red-to-blue gradient elsewhere, so a fill is easy to check.
const W = 120, H = 90;
const SUBJ = [40, 20, 80, 85] as const; // x0, y0, x1, y1
function scene() {
  const u16 = new Uint16Array(W * H), px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x, inside = x >= SUBJ[0] && x < SUBJ[2] && y >= SUBJ[1] && y < SUBJ[3];
      u16[i] = Math.round((inside ? 0.85 : 0.2 + 0.15 * (y / H)) * 65535);
      px[i * 4] = inside ? 128 : 255 - Math.round((x / W) * 255);
      px[i * 4 + 1] = inside ? 128 : 0;
      px[i * 4 + 2] = inside ? 128 : Math.round((x / W) * 255);
      px[i * 4 + 3] = 255;
    }
  return { u16, px };
}

describe("layers", () => {
  it("blurs with a normalised kernel", () => {
    const f = new Float32Array(W * H).fill(0.5);
    const b = gaussianBlur(f, W, H, 3);
    expect(b[0]).toBeCloseTo(0.5, 5);
    expect(b[W * H - 1]).toBeCloseTo(0.5, 5);
  });

  it("measures distance to a mask", () => {
    const m = new Uint8Array(W * H);
    m[45 * W + 60] = 1;
    const d = distanceOutside(m, W, H);
    expect(d[45 * W + 60]).toBe(0);
    expect(d[45 * W + 65]).toBeCloseTo(5, 5);
    expect(d[50 * W + 65]).toBeCloseTo(5 * Math.SQRT2, 3);
  });

  it("fills a hole from its rim with pull-push", () => {
    const c = new Float32Array(W * H), known = new Float32Array(W * H).fill(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { c[y * W + x] = x < 60 ? 10 : 20; }
    for (let y = 30; y < 60; y++) for (let x = 50; x < 70; x++) { known[y * W + x] = 0; c[y * W + x] = -999; }
    pullPush([c], known, W, H);
    for (let y = 30; y < 60; y++) for (let x = 50; x < 70; x++) { const v = c[y * W + x]; expect(v).toBeGreaterThan(9); expect(v).toBeLessThan(21); }
    expect(c[45 * W + 52]).toBeLessThan(c[45 * W + 68]); // left of the hole leans to 10, right to 20
    expect(c[10 * W + 10]).toBe(10);                   // known pixels untouched
  });

  it("finds the valley between subject and background depths", () => {
    const { u16 } = scene();
    const d = Float32Array.from(u16, (v) => v / 65535);
    const tau = subjectThreshold(d, 0.85, 0.27);
    expect(tau).toBeGreaterThan(0.4);
    expect(tau).toBeLessThan(0.8);
    const o = otsu(d);
    expect(o.near).toBeGreaterThan(0.8);
    expect(o.far).toBeLessThan(0.4);
    expect(o.cover).toBeCloseTo((40 * 65) / (W * H), 1);
  });

  it("builds a subject layer, a filled plate and a background depth", () => {
    const { u16, px } = scene();
    const L = buildLayers(px, u16, W, H, [SUBJ[0], SUBJ[1], SUBJ[2], SUBJ[3]], 0.85, 0.27);
    expect(L.matte).not.toBeNull();
    expect(L.plate).not.toBeNull();
    const at = (x: number, y: number) => y * W + x;
    // Tight alpha hugs the subject; grown alpha reaches past it; both are zero far away.
    expect(L.tight[at(60, 50)]).toBe(255);
    expect(L.tight[at(30, 50)]).toBe(0);
    expect(L.grown[at(60, 50)]).toBe(255);
    expect(L.grown[at(SUBJ[0] - 1, 50)]).toBe(255);     // the hole rim is still fully covered
    expect(L.grown[at(5, 5)]).toBe(0);
    // The plate inside the hole is filled from the gradient around it, not the grey subject.
    const p = L.plate!;
    const i = at(60, 50) * 4;
    expect(p[i + 3]).toBe(255);                         // hole alpha
    expect(p[i + 1]).toBeLessThan(10);                  // green stays ~0 (gradient), not 128 (subject)
    expect(p[i]).toBeGreaterThan(60); expect(p[i]).toBeLessThan(200);
    expect(p[at(5, 5) * 4 + 3]).toBe(0);                // outside the hole: not a plate pixel
    // Background depth under the subject is far, like its surroundings.
    expect(L.bgDepth[at(60, 50)] / 65535).toBeLessThan(0.45);
    expect(L.bgDepth[at(10, 10)] / 65535).toBeLessThan(0.3);
    expect(L.matte!.sep).toBeGreaterThan(0.4);
    expect(L.matte!.cover).toBeGreaterThan(0.2);
    // The maps texture: R far under the subject, G near, alphas from the planes.
    const m = composeMaps(u16, L.bgDepth, { tight: L.tight, grown: L.grown }, W, H);
    const j = at(60, 50) * 4;
    expect(m[j]).toBeLessThan(0.45); expect(m[j + 1]).toBeCloseTo(0.85, 2); expect(m[j + 2]).toBe(1); expect(m[j + 3]).toBe(1);
    const k = at(5, 5) * 4;
    expect(m[k + 1]).toBeGreaterThan(0.7);              // subject depth is extended past the matte, not far
  });

  it("falls back to a near/far split without a subject box, and to one layer on flat scenes", () => {
    const { u16, px } = scene();
    const L = buildLayers(px, u16, W, H, null, 0.3, 0.3);
    expect(L.matte).not.toBeNull();
    expect(L.tight[50 * W + 60]).toBe(255);
    const flat = new Uint16Array(W * H).fill(30000);
    const F = buildLayers(px, flat, W, H, null, 0.46, 0.46);
    expect(F.matte).toBeNull();
    expect(F.plate).toBeNull();
    expect(F.bgDepth[0]).toBe(30000);
  });
});

describe("wholePeople", () => {
  it("adds the rest of a mostly-held person and drops a mostly-missed one", async () => {
    const { wholePeople } = await import("./layers");
    const W = 60, H = 40, a = new Float32Array(W * H), p = new Uint8Array(W * H);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 15; x++) { p[y * W + x] = 255; if (y < 28) a[y * W + x] = 1; }   // 77 % held
    for (let y = 5; y < 35; y++) for (let x = 35; x < 45; x++) { p[y * W + x] = 255; if (y < 10) a[y * W + x] = 1; }  // 17 % held
    wholePeople(a, p, W, H);
    expect(a[32 * W + 10]).toBe(1);
    expect(a[7 * W + 40]).toBe(0);
  });
});
