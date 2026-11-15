import { describe, expect, it } from "vitest";
import { border, cameraFor, clampViewFlat, fitView, liveBounds } from "./camera";
import { compile } from "./compile";
import { containVs, fitFrame, frameGroups, resizeFrom, stageSize, straighten } from "./framing";
import { plan } from "./plan";
import type { CamKey, MediaAnalysis, Project, RenderSlide } from "./types";
import type { V3 } from "./camera";

const k = (t: number, view: V3): CamKey => ({ t, view, cam: [0, 0, 0], f: 1, ds: 0 });
const photo = (i: number, w: number, h: number, faces: [number, number, number, number][] = []): MediaAnalysis => ({
  info: { hash: `h${i}`, kind: "photo", name: `p${i}.jpg`, w, h, taken: 1_700_000_000_000 + i * 60_000, bytes: 1000 },
  basics: { phash: ((i * 2654435761) >>> 0).toString(16).padStart(16, "0"), sharpness: 500, exposure: 0.5, contrast: 0.2, colorfulness: 30, edgeDensity: 0.3, clipped: { dark: 0, bright: 0 }, flags: [] },
  faces: faces.map((box) => ({ box, score: 0.9 })),
  saliency: { peaks: [{ box: [w * 0.3, h * 0.3, w * 0.6, h * 0.7], score: 1 }], center: [0.5, 0.5] },
});
/** The renderer's framing for a layer at slide progress x (renderer.ts `frame`, without beat accents). */
const rendered = (l: RenderSlide, x: number, aspect: number): V3 => {
  const cam = cameraFor(l.keys, x, l.aim, l.k ?? 0, l.pivot ?? 0.5);
  return fitView(cam.view, liveBounds(cam, l.pivot ?? 0.5, border(l.w / l.h, null)), aspect, l.cover!);
};

describe("framing editor geometry", () => {
  it("groups a sweep's dwell keys into one frame and labels start, stops and end", () => {
    const a: V3 = [-0.3, 0, 0.5], b: V3 = [0.3, 0, 0.5], c: V3 = [0, 0, 0.9];
    const g = frameGroups([k(0, a), k(0.1, a), k(0.4, b), k(0.5, b), k(1, c)]);
    expect(g.map((x) => x.label)).toEqual(["Start", "Stop 1", "End"]);
    expect(g.map((x) => x.keys)).toEqual([[0, 1], [2, 3], [4]]);
    // A tour that starts and ends on the same view keeps both as separate frames.
    expect(frameGroups([k(0, c), k(0.5, a), k(1, c)]).map((x) => x.label)).toEqual(["Start", "Stop 1", "End"]);
    // A still move (start = end) keeps a separate end, so the two can be pulled apart.
    expect(frameGroups([k(0, c), k(1, c)]).map((x) => x.keys)).toEqual([[0], [1]]);
    // A key repeating the last view before the end is a stop of its own.
    expect(frameGroups([k(0, a), k(0.8, c), k(1, c)]).map((x) => x.label)).toEqual(["Start", "Stop 1", "End"]);
  });
  it("lets a frame grow to the whole photo, never further, and keeps it inside the photo where it fits", () => {
    const ia = 4 / 3, aspect = 16 / 9;
    expect(containVs(ia, aspect)).toBe(1);
    expect(fitFrame([0.4, 0.2, 3], ia, aspect)).toEqual([0, 0, 1]);
    const [sw, sh] = stageSize(ia, aspect);
    expect(sw).toBeCloseTo(aspect); expect(sh).toBe(1);
    const v = fitFrame([0.9, 0, 0.4], ia, aspect);
    expect(v[0] + (v[2] * aspect) / 2).toBeLessThanOrEqual(ia / 2 + 1e-9);
    // Panorama: the whole photo is wider than the screen, so the stage is the photo's width and the frame's height.
    expect(stageSize(3, aspect)).toEqual([3, 3 / aspect]);
  });
  it("resizes from a corner with the opposite corner fixed", () => {
    const ia = 4 / 3, aspect = 16 / 9, v0: V3 = [0, 0, 0.4];
    const tl: [number, number] = [-(0.4 * aspect) / 2, -0.2];
    const v = resizeFrom(v0, [1, 1], [0.3, 0.3], ia, aspect);
    expect(v[0] - (v[2] * aspect) / 2).toBeCloseTo(tl[0], 9);
    expect(v[1] - v[2] / 2).toBeCloseTo(tl[1], 9);
    expect(v[2]).toBeCloseTo(0.5, 9);
  });
  it("straightens a track with stops into its first and last key", () => {
    const s = straighten([k(0, [0, 0, 1]), k(0.5, [0.2, 0, 0.5]), k(1, [0, 0, 0.8])]);
    expect(s.map((x) => [x.t, x.view[2]])).toEqual([[0, 1], [1, 0.8]]);
  });
});

describe("edited framing reaches the renderer", () => {
  const aspect = 16 / 9;
  const media = Array.from({ length: 12 }, (_, i) => photo(i, i % 3 === 0 ? 3000 : 4000, i % 3 === 0 ? 4000 : 3000,
    i % 4 === 1 ? [[1000, 800, 1400, 1300]] : i % 4 === 2 ? [[500, 800, 800, 1100], [1500, 700, 1800, 1000], [2800, 900, 3100, 1200]] : []));
  const analysis = new Map(media.map((m) => [m.info.hash, m]));
  const project = (): Project => {
    const p: Project = { v: 1, id: "p", title: "t", seed: 42, created: 0, updated: 0, output: { aspect: "16:9", height: 1080, fps: 30 }, styleId: "classic", styleOverrides: {},
      media: media.map((m) => m.info.hash), excluded: [], starred: [], order: "time", songs: [], fit: "show-to-music", slides: [], titles: { chapters: false }, generativeFill: "off", beatSync: "cuts", depthStrength: 1 };
    p.slides = plan(p, analysis, new Map()).slides;
    return p;
  };

  it("honours a push in and a pull out to the whole photo, on every slide, through a re-plan", () => {
    const p = project();
    const wants = new Map<string, [V3, V3]>();
    for (const s of p.slides) {
      if (s.kind !== "photo") continue;
      const m = analysis.get(s.items[0])!, ia = m.info.w / m.info.h;
      const a = clampViewFlat(-ia / 4, -0.2, 0.4, ia, aspect), b = clampViewFlat(0, 0, containVs(ia, aspect), ia, aspect);
      // What the editor commits: a straight move (stops removed) from a tight crop out to the whole photo.
      s.treatment.keys = [{ ...s.treatment.keys[0], t: 0, view: a }, { ...s.treatment.keys[s.treatment.keys.length - 1], t: 1, view: b }];
      s.locks.treatment = true;
      wants.set(s.id, [a, b]);
    }
    expect(wants.size).toBeGreaterThan(4);
    p.slides = plan(p, analysis, new Map()).slides; // locked framing must survive re-planning
    const tl = compile(p, analysis, new Map());
    for (const [id, [a, b]] of wants) {
      const l = tl.layers.find((x) => x.id === id)!;
      const f0 = rendered(l, 0, aspect), f1 = rendered(l, 1, aspect);
      // Within 1 %: the renderer keeps a covering axis 0.5 % inside the photo's edge (camera.ts fitView).
      for (let j = 0; j < 3; j++) { expect(Math.abs(f0[j] - a[j]), `${id} start`).toBeLessThan(0.01); expect(Math.abs(f1[j] - b[j]), `${id} end`).toBeLessThan(0.01); }
    }
  });

  it("uses a pair's per-photo framing", () => {
    const p = project();
    const s = p.slides.find((x) => x.kind === "pair")!;
    expect(s).toBeTruthy();
    const ia = 3000 / 4000, ca = aspect / 2;
    const a = clampViewFlat(0, -0.25, 0.45, ia, ca), b = clampViewFlat(0, 0, 0.95, ia, ca);
    s.treatment.cells = [[k(0, a), k(1, b)], [k(0, b), k(1, a)]];
    const l = compile(p, analysis, new Map()).layers.find((x) => x.id === s.id)!;
    const left = l.cells![0].slide, right = l.cells![1].slide;
    expect(rendered(left, 0, ca)[2]).toBeCloseTo(0.45, 3);
    expect(rendered(right, 0, ca)[2]).toBeCloseTo(0.95, 3);
    expect(rendered(left, 1, ca)[1]).toBeCloseTo(b[1], 3);
  });
});
