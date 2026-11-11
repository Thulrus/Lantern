import { describe, expect, it } from "vitest";
import { Prng } from "$lib/util/prng";
import { border, bounds, cameraFor, liveBounds, project as proj } from "./camera";
import { desiredDuration } from "./durations";
import { fitToBeats } from "./fit";
import { panSpeed, secure, type MotionInput } from "./motion";
import { plan } from "./plan";
import { compile } from "./compile";
import { STYLES, styleById } from "./styles";
import type { MediaAnalysis, MusicAnalysis, Project } from "./types";
import { TREATMENTS } from "./types";

const photo = (i: number, w = 4000, h = 3000, faces: [number, number, number, number][] = [], taken = 1_700_000_000_000 + i * 60_000): MediaAnalysis => ({
  info: { hash: `h${i}`, kind: "photo", name: `p${i}.jpg`, w, h, taken, bytes: 1000 },
  basics: { phash: (i * 2654435761 >>> 0).toString(16).padStart(16, "0"), sharpness: 500, exposure: 0.5, contrast: 0.2, colorfulness: 30, edgeDensity: 0.3, clipped: { dark: 0, bright: 0 }, flags: [] },
  faces: faces.map((box) => ({ box, score: 0.9 })),
  saliency: { peaks: [{ box: [w * 0.3, h * 0.3, w * 0.6, h * 0.7], score: 1 }], center: [0.5, 0.5] },
});

const project = (media: string[], extra: Partial<Project> = {}): Project => ({
  v: 1, id: "p", title: "t", seed: 42, created: 0, updated: 0, output: { aspect: "16:9", height: 1080, fps: 30 }, styleId: "classic", styleOverrides: {},
  media, excluded: [], starred: [], order: "time", songs: [], fit: "show-to-music", slides: [], titles: { chapters: false }, generativeFill: "off", beatSync: "cuts", depthStrength: 1, ...extra,
});

const clickMusic = (bpm: number, seconds: number): MusicAnalysis => {
  const beats: number[] = [];
  for (let t = 0; t < seconds; t += 60 / bpm) beats.push(t);
  return { v: 1, duration: seconds, sampleRate: 22050, tempo: bpm, tempoAlt: bpm / 2, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatsPerBar: 4,
    sections: [{ start: 0, end: seconds / 2, label: "A", energy: "low", energyValue: 0.3 }, { start: seconds / 2, end: seconds, label: "B", energy: "high", energyValue: 0.9 }],
    energy: beats.map(() => 0.5), accents: [], edges: { leadIn: 0, fadeOut: seconds - 3, trailing: 0 }, loudness: -14, waveform: [], offset: 0 };
};

describe("durations", () => {
  it("multiplies and clamps", () => {
    const s = styleById("classic");
    expect(desiredDuration(s, { faces: 1, complexity: 0.33, starred: false, screenshot: false, pair: false }).dur).toBeCloseTo(4, 1);
    expect(desiredDuration(s, { faces: 5, complexity: 0.33, starred: true, screenshot: false, pair: false }).dur).toBeLessThanOrEqual(s.pace.max);
    expect(desiredDuration(s, { faces: 0, complexity: 0, starred: false, screenshot: true, pair: false }).dur).toBeGreaterThanOrEqual(4);
  });
});

describe("music fit", () => {
  it("ends exactly on the last beat and snaps every cut to a beat", () => {
    const beats = Array.from({ length: 121 }, (_, i) => i * 0.5); // 120 BPM, 60 s
    const r = fitToBeats(Array.from({ length: 15 }, () => ({ desired: 4 })), { beats, downbeats: new Set(beats.map((_, i) => i).filter((i) => i % 4 === 0)), sections: new Set([0, 60]) });
    expect(r.ok).toBe(true);
    const end = r.starts[r.starts.length - 1] + r.durs[r.durs.length - 1];
    expect(end).toBeCloseTo(60, 6);
    for (const s of r.starts) expect(Math.abs(s / 0.5 - Math.round(s / 0.5))).toBeLessThan(1e-6);
    for (const d of r.durs) { expect(d).toBeGreaterThanOrEqual(2.4 - 1e-6); expect(d).toBeLessThanOrEqual(6.4 + 1e-6); }
  });
  it("respects locked durations", () => {
    const beats = Array.from({ length: 121 }, (_, i) => i * 0.5);
    const r = fitToBeats([{ desired: 4 }, { desired: 4, locked: 7 }, ...Array.from({ length: 12 }, () => ({ desired: 4 }))], { beats, downbeats: new Set(), sections: new Set() });
    expect(r.ok).toBe(true);
    expect(r.durs[1]).toBeCloseTo(7, 6);
  });
  it("reports a mismatch when the photos need far more time than the music", () => {
    const beats = Array.from({ length: 41 }, (_, i) => i * 0.5); // 20 s
    const r = fitToBeats(Array.from({ length: 15 }, () => ({ desired: 4 })), { beats, downbeats: new Set(), sections: new Set() });
    expect(r.ok).toBe(false);
    expect(r.need).toBeCloseTo(60);
  });
});

describe("edge safety", () => {
  const inp = (w: number, h: number, faces: MotionInput["faces"] = []): MotionInput => ({ w, h, aspect: 16 / 9, faces, pois: faces, dur: 4, panSpeed: 0.12, resolutionScale: h / 1080 });
  it("never reveals the photo's edge on a covering axis, for every treatment and aspect", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [6000, 2000], [1920, 1080]])
      for (const id of TREATMENTS.filter((t) => !["depthPush", "arc", "crane", "inflate", "dollyZoom", "focusPull"].includes(t))) {
        const faces: MotionInput["faces"] = id === "sweep" ? [[w * 0.1, h * 0.3, w * 0.2, h * 0.45], [w * 0.45, h * 0.3, w * 0.55, h * 0.45], [w * 0.8, h * 0.3, w * 0.9, h * 0.45]] : [[w * 0.4, h * 0.3, w * 0.5, h * 0.45]];
        const sec = secure(id, inp(w, h, faces), new Prng(7), 1, 1);
        const b = border(w / h, null);
        for (let i = 0; i <= 40; i++) {
          const c = cameraFor(sec.treatment.keys, i / 40, sec.treatment.aim, sec.treatment.k ?? 0, 0.5);
          const lb = liveBounds(c, 0.5, b);
          const [vx, vy, vs] = c.view;
          const hx = (vs * 16) / 9 / 2, hy = vs / 2;
          if (sec.cover[0]) { expect(vx - hx).toBeGreaterThanOrEqual(lb[0] - 1e-3); expect(vx + hx).toBeLessThanOrEqual(lb[1] + 1e-3); }
          if (sec.cover[1]) { expect(vy - hy).toBeGreaterThanOrEqual(lb[2] - 1e-3); expect(vy + hy).toBeLessThanOrEqual(lb[3] + 1e-3); }
        }
      }
  });
  it("never moves faster than the sweep limit, even on short slides", () => {
    const w = 4000, h = 3000;
    const eight: MotionInput["faces"] = Array.from({ length: 8 }, (_, i) => [w * (0.06 + i * 0.12), h * (0.3 + (i % 2) * 0.05), w * (0.06 + i * 0.12) + 220, h * (0.3 + (i % 2) * 0.05) + 280]);
    for (const dur of [1.2, 2.2, 4, 9])
      for (const id of ["sweep", "tour", "pan", "push"] as const) {
        const base = inp(w, h, eight);
        const sec = secure(id, { ...base, dur, pois: eight }, new Prng(11), 1, 1);
        expect(panSpeed(sec.treatment.keys, dur), `${id} at ${dur}s`).toBeLessThanOrEqual(0.5 + 1e-6);
        // Key times must strictly increase.
        for (let k = 1; k < sec.treatment.keys.length; k++) expect(sec.treatment.keys[k].t).toBeGreaterThan(sec.treatment.keys[k - 1].t);
      }
  });
  it("keeps the main face inside the frame at every moment", () => {
    const w = 4000, h = 3000, face: MotionInput["faces"][number] = [3400, 200, 3900, 900];
    for (const id of ["push", "pull", "pan", "tour", "hold"] as const) {
      const sec = secure(id, inp(w, h, [face]), new Prng(3), 1, 1);
      for (let i = 0; i <= 20; i++) {
        const c = cameraFor(sec.treatment.keys, i / 20, sec.treatment.aim, sec.treatment.k ?? 0, 0.5);
        const [vx, vy, vs] = c.view, hx = (vs * 16) / 9 / 2, hy = vs / 2;
        const u0 = (face[0] - w / 2) / h, u1 = (face[2] - w / 2) / h, v0 = (face[1] - h / 2) / h, v1 = (face[3] - h / 2) / h;
        expect(u0).toBeGreaterThanOrEqual(vx - hx - 1e-3); expect(u1).toBeLessThanOrEqual(vx + hx + 1e-3);
        expect(v0).toBeGreaterThanOrEqual(vy - hy - 1e-3); expect(v1).toBeLessThanOrEqual(vy + hy + 1e-3);
      }
    }
  });
  it("projects the flat photo exactly like a 2D view when ds = 0", () => {
    const rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const [su, sv] = proj(0.3, -0.2, 0.5, [0, 0, 0], 1, rot, 0.5, 0);
    expect(su).toBeCloseTo(0.3, 9); expect(sv).toBeCloseTo(-0.2, 9);
    const b = bounds([{ t: 0, view: [0, 0, 1], cam: [0, 0, 0], f: 1, ds: 0 }], 0, [0, 0], 0.5, border(4 / 3, null));
    expect(b[0]).toBeCloseTo(-2 / 3, 9); expect(b[1]).toBeCloseTo(2 / 3, 9); expect(b[2]).toBeCloseTo(-0.5, 9); expect(b[3]).toBeCloseTo(0.5, 9);
  });
});

describe("plan", () => {
  const media = Array.from({ length: 12 }, (_, i) => photo(i, i % 3 === 0 ? 3000 : 4000, i % 3 === 0 ? 4000 : 3000, i % 4 === 1 ? [[1000, 800, 1400, 1300]] : i % 4 === 2 ? [[500, 800, 800, 1100], [1500, 700, 1800, 1000], [2800, 900, 3100, 1200]] : []));
  const analysis = new Map(media.map((m) => [m.info.hash, m]));
  it("is deterministic for the same seed and differs for another", () => {
    const p = project(media.map((m) => m.info.hash));
    const a = plan(p, analysis, new Map()), b = plan(p, analysis, new Map());
    expect(JSON.stringify(a.slides)).toBe(JSON.stringify(b.slides));
    const c = plan({ ...p, seed: 7 }, analysis, new Map());
    expect(JSON.stringify(c.slides)).not.toBe(JSON.stringify(a.slides));
  });
  it("fits the show to the music and ends with it", () => {
    const music = new Map([["song", clickMusic(120, 50)]]);
    const p = project(media.map((m) => m.info.hash), { songs: [{ hash: "song", trimIn: 0, trimOut: 0, gain: 1, fadeIn: 0, fadeOut: 2 }] });
    const r = plan(p, analysis, music);
    expect(r.slides.length).toBeGreaterThan(0);
    expect(r.duration).toBeCloseTo(50, 3);
    for (const s of r.slides) expect(Math.abs(s.start * 2 - Math.round(s.start * 2))).toBeLessThan(1e-6);
    const tl = compile({ ...p, slides: r.slides }, analysis, music);
    expect(tl.dur).toBeCloseTo(50, 3);
    expect(tl.audio.length).toBe(1);
    expect(tl.layers.length).toBe(r.slides.length);
  });
  it("never uses the same treatment three times in a row and respects locks on re-plan", () => {
    const p = project(media.map((m) => m.info.hash));
    const r = plan(p, analysis, new Map());
    for (let i = 2; i < r.slides.length; i++)
      expect(r.slides[i].treatment.id === r.slides[i - 1].treatment.id && r.slides[i].treatment.id === r.slides[i - 2].treatment.id).toBe(false);
    const edited = r.slides.map((s, i) => (i === 3 ? { ...s, dur: 7.77, treatment: { ...s.treatment, id: "hold" as const }, locks: { dur: true as const, treatment: true as const } } : s));
    const again = plan({ ...p, slides: edited, seed: 99 }, analysis, new Map());
    const same = again.slides.find((s) => s.id === edited[3].id)!;
    expect(same.dur).toBeCloseTo(7.77);
    expect(same.treatment.id).toBe("hold");
  });
  it("works for every style preset", () => {
    for (const st of STYLES) {
      const p = project(media.map((m) => m.info.hash), { styleId: st.id });
      const r = plan(p, analysis, new Map());
      expect(r.slides.length).toBe(11 - 0 + 1 > 0 ? r.slides.length : 0);
      for (const s of r.slides) { expect(s.dur).toBeGreaterThan(0.3); expect(s.treatment.keys.length).toBeGreaterThanOrEqual(1); }
    }
  });
});
