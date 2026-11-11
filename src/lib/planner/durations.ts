// Pass 4, desired durations (spec §5.4): desired = pace_base × Π multipliers, clamped to the style.
import { clamp } from "$lib/util/math";
import type { MediaAnalysis, MusicAnalysis, Style } from "./types";

export interface DurationInput {
  faces: number;
  complexity: number;      // 0..1 (edge density)
  starred: boolean;
  screenshot: boolean;
  pair: boolean;
  video?: number;          // clip length when it is a video
  energy?: "low" | "mid" | "high";
  treatmentMin?: number;
}

export function desiredDuration(style: Style, d: DurationInput): { dur: number; reasons: string[] } {
  if (d.video !== undefined) return { dur: d.video, reasons: [`video clip ${d.video.toFixed(1)} s`] };
  let m = 1;
  const reasons: string[] = [`${style.name} pace ${style.pace.base} s`];
  if (d.faces >= 2) { const k = Math.min(1.8, 1 + 0.15 * (d.faces - 1)); m *= k; reasons.push(`${d.faces} faces ×${k.toFixed(2)}`); }
  const c = 0.9 + 0.3 * clamp(d.complexity, 0, 1);
  m *= c;
  if (Math.abs(c - 1) > 0.05) reasons.push(`detail ×${c.toFixed(2)}`);
  if (d.starred) { m *= 1.5; reasons.push("starred ×1.5"); }
  if (d.screenshot) { m *= 1.6; reasons.push("readable ×1.6"); }
  if (d.pair) { m *= 1.3; reasons.push("pair ×1.3"); }
  if (d.energy === "high") { m *= 0.75; reasons.push("high energy ×0.75"); }
  else if (d.energy === "low") { m *= 1.3; reasons.push("quiet passage ×1.3"); }
  let dur = style.pace.base * m;
  if (d.screenshot) dur = Math.max(dur, 4);
  if (d.treatmentMin) dur = Math.max(dur, d.treatmentMin);
  dur = clamp(dur, style.pace.min, style.pace.max);
  return { dur, reasons };
}

/** Minimum duration a treatment needs to read (spec §5.4). */
export function treatmentMinimum(id: string, faces: number, stops: number): number {
  if (id === "arc") return 4;
  if (id === "sweep") return 1.0 * faces + 1.5;
  if (id === "tour") return 1.2 * stops + 1.5;
  return 0;
}

/** Section energy at a show time, from the music analysis. */
export function energyAt(music: MusicAnalysis | undefined, t: number): "low" | "mid" | "high" | undefined {
  if (!music) return undefined;
  const s = music.sections.find((x) => t >= x.start && t < x.end);
  return s?.energy;
}
