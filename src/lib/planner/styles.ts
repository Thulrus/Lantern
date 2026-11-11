// Style presets (spec §5.10). Styles are data so users can save their own.
import type { Style } from "./types";

const base: Omit<Style, "id" | "name" | "blurb"> = {
  pace: { base: 4.0, min: 1.6, max: 9 },
  treatmentWeights: { hold: 1, push: 3, pull: 1.5, pan: 2, sweep: 3, tour: 1.5, depthPush: 2, arc: 2, crane: 1, inflate: 1, dollyZoom: 0.3, focusPull: 1 },
  transitionWeights: { minor: { crossfade: 3, cut: 0.5, depthWipe: 1 }, major: { dipBlack: 2, crossfade: 1, flyThrough: 1 } },
  depthShare: 0.5,
  depthAmount: 1,
  generativeFill: "off",
  beatSync: "cuts",
  look: { default: "photo" },
  titles: { font: "Lantern Sans", animation: "fade" },
  crossfade: 1.2,
  panSpeed: 0.12,
};

export const STYLES: Style[] = [
  {
    ...base, id: "classic", name: "Classic", blurb: "2D Ken Burns and crossfades only. Safe, timeless.",
    treatmentWeights: { hold: 1, push: 3, pull: 1.5, pan: 2, sweep: 3, tour: 1 },
    transitionWeights: { minor: { crossfade: 4, cut: 0.3 }, major: { dipBlack: 2, crossfade: 1 } },
    depthShare: 0, depthAmount: 0, crossfade: 1.4,
  },
  {
    ...base, id: "gentle", name: "Gentle", blurb: "Slow, warm, long crossfades, subtle 3D. For memorials and family.",
    pace: { base: 5.5, min: 3, max: 11 },
    treatmentWeights: { hold: 1.5, push: 3, pull: 2, pan: 1.5, sweep: 3, tour: 1, depthPush: 1.5, arc: 1, crane: 0.5, focusPull: 1 },
    transitionWeights: { minor: { crossfade: 5 }, major: { dipBlack: 1, crossfade: 2 } },
    depthShare: 0.3, depthAmount: 0.6, crossfade: 2.2, panSpeed: 0.08, grade: { film: 0.2 },
  },
  {
    ...base, id: "cinematic", name: "Cinematic", blurb: "Strong 3D, film grade, transitions on sections.",
    pace: { base: 4.0, min: 1.8, max: 9 },
    treatmentWeights: { hold: 0.5, push: 2, pull: 1, pan: 1.5, sweep: 3, tour: 1.5, depthPush: 3, arc: 3, crane: 2, inflate: 1.5, dollyZoom: 0.5, focusPull: 1.5 },
    transitionWeights: { minor: { crossfade: 2, cut: 1, depthWipe: 2 }, major: { dipBlack: 2, flyThrough: 2, whip: 0.5 } },
    depthShare: 0.7, depthAmount: 1.2, generativeFill: "margins", beatSync: "cuts+accents", grade: { film: 0.5 },
  },
  {
    ...base, id: "upbeat", name: "Upbeat", blurb: "Short beats, cuts on beats, whips and pushes, grid reveals.",
    pace: { base: 2.6, min: 0.8, max: 6 },
    treatmentWeights: { hold: 0.5, push: 4, pull: 2, pan: 2, sweep: 2, tour: 1, depthPush: 2, arc: 1, inflate: 1, dollyZoom: 0.5 },
    transitionWeights: { minor: { cut: 4, crossfade: 1, push: 1 }, major: { whip: 2, push: 2, dipBlack: 0.5 } },
    depthShare: 0.4, beatSync: "cuts+accents", crossfade: 0.4, panSpeed: 0.2, gridReveal: true,
  },
  {
    ...base, id: "travel", name: "Travel", blurb: "Chapter cards by day, establishing shots first, pushes into landscapes.",
    treatmentWeights: { hold: 1, push: 3, pull: 1.5, pan: 3, sweep: 2, tour: 2, depthPush: 3, arc: 1.5, crane: 2, inflate: 1 },
    transitionWeights: { minor: { crossfade: 3, cut: 1, depthWipe: 1.5 }, major: { dipBlack: 2, flyThrough: 1.5 } },
    depthShare: 0.6, generativeFill: "margins",
  },
  {
    ...base, id: "dreamlike", name: "Dreamlike", blurb: "Creative looks mixed in, scan reveals, slow drifting moves.",
    pace: { base: 5, min: 2.5, max: 10 },
    treatmentWeights: { hold: 1, push: 2, pull: 2, pan: 2, sweep: 2, tour: 1, depthPush: 2, arc: 3, crane: 1.5, inflate: 1.5, focusPull: 2 },
    transitionWeights: { minor: { crossfade: 4, scan: 1.5 }, major: { dipWhite: 1, scan: 2, crossfade: 1 } },
    depthShare: 0.7, depthAmount: 1, look: { default: "photo", mix: { photo: 5, topo: 1.5, engraving: 1, hologram: 0.7, thermal: 0.3 } },
    crossfade: 2, grade: { film: 0.3 },
  },
];

export const styleById = (id: string): Style => STYLES.find((s) => s.id === id) ?? STYLES[0];

export function resolveStyle(id: string, overrides: Partial<Style>): Style {
  const s = styleById(id);
  return { ...s, ...overrides, pace: { ...s.pace, ...(overrides.pace ?? {}) } };
}
