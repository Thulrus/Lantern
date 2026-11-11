import { describe, expect, it } from "vitest";
import { analyzeMusic, SR } from "./analyze";

/** A synthetic click track: short decaying noise bursts at a known tempo, with a timbre change
 *  (added low tone) at a known time, so sections should split there. */
function clickTrack(bpm: number, seconds: number, changeAt: number, seed = 1): Float32Array {
  const n = Math.floor(seconds * SR), x = new Float32Array(n);
  const period = (60 / bpm) * SR;
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  for (let b = 0; b * period < n; b++) {
    const start = Math.round(b * period);
    const accent = b % 4 === 0 ? 1.0 : 0.5;
    for (let i = 0; i < 1200 && start + i < n; i++) x[start + i] += accent * rnd() * Math.exp(-i / 250);
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tone = t < changeAt ? Math.sin(2 * Math.PI * 220 * t) * 0.15 : Math.sin(2 * Math.PI * 110 * t) * 0.15 + Math.sin(2 * Math.PI * 330 * t) * 0.1;
    x[i] += tone;
  }
  return x;
}

describe("music analysis", () => {
  it("finds the tempo and beats of a click track", () => {
    const bpm = 128;
    const a = analyzeMusic([clickTrack(bpm, 40, 20)], SR);
    expect(Math.abs(a.tempo - bpm) / bpm).toBeLessThan(0.04);
    // Beats within 20 ms of the true grid (allowing the octave ambiguity on which beats are found).
    const period = 60 / bpm;
    const hits = a.beats.filter((b) => { const k = Math.round(b / period); return Math.abs(b - k * period) < 0.02; });
    expect(hits.length / a.beats.length).toBeGreaterThan(0.85);
    expect(a.beatsPerBar).toBe(4);
  }, 60_000);

  it("places a section boundary at the timbre change", () => {
    const a = analyzeMusic([clickTrack(120, 60, 30)], SR);
    expect(a.sections.length).toBeGreaterThanOrEqual(2);
    const near = a.sections.some((s) => Math.abs(s.start - 30) <= 2.1); // within one bar at 120 BPM
    expect(near).toBe(true);
  }, 60_000);

  it("handles slow tempos", () => {
    const a = analyzeMusic([clickTrack(72, 40, 100)], SR);
    const ok = Math.abs(a.tempo - 72) / 72 < 0.04 || Math.abs(a.tempo - 144) / 144 < 0.04;
    expect(ok).toBe(true);
  }, 60_000);
});
