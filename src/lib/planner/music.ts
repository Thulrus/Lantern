// The show's music timeline (spec §6.4): songs in order with trims, gains and crossfades, and
// the merged beat grid in show time. A song change counts as a section boundary.
import type { AudioEvent, MusicAnalysis, Project, SongRef } from "./types";

export const SONG_CROSSFADE = 4;

export interface MusicGrid {
  total: number;                  // seconds of music in show time
  beats: number[];                // show time
  downbeats: Set<number>;         // indices into beats
  sections: Set<number>;          // indices into beats that start a section (or a song)
  sectionAt: (t: number) => MusicAnalysis["sections"][number] | undefined;
  accents: number[];              // show time
  tempo: number;
  beatLen: number;
  songs: { ref: SongRef; analysis: MusicAnalysis; at: number; in: number; out: number }[];
  fadeOutAt: number;              // show time where the last song starts to fade
}

export function musicGrid(project: Project, analyses: Map<string, MusicAnalysis>): MusicGrid | null {
  const songs: MusicGrid["songs"] = [];
  let at = 0;
  for (const ref of project.songs) {
    const a = analyses.get(ref.hash);
    if (!a) continue;
    const tin = Math.max(0, ref.trimIn), tout = ref.trimOut > 0 ? Math.min(a.duration, ref.trimOut) : a.duration;
    if (tout - tin < 1) continue;
    if (songs.length) at -= Math.min(SONG_CROSSFADE, (tout - tin) / 2);
    songs.push({ ref, analysis: a, at, in: tin, out: tout });
    at += tout - tin;
  }
  if (!songs.length) return null;
  const total = at;
  const beats: number[] = [], downbeats = new Set<number>(), sections = new Set<number>(), accents: number[] = [];
  let lastEnd = -Infinity;
  for (const s of songs) {
    const db = new Set(s.analysis.downbeats.map((b) => Math.round(b * 1000)));
    const starts = new Set(s.analysis.sections.map((x) => Math.round(x.start * 1000)));
    let first = true;
    for (const b of s.analysis.beats) {
      const shift = b + s.analysis.offset;
      if (shift < s.in || shift > s.out) continue;
      const t = s.at + (shift - s.in);
      if (t <= lastEnd + 0.05) continue; // inside the crossfade the earlier song's grid wins
      beats.push(t);
      const i = beats.length - 1, key = Math.round(b * 1000);
      if (db.has(key)) downbeats.add(i);
      if (first || starts.has(key)) { sections.add(i); first = false; }
    }
    for (const a of s.analysis.accents) if (a >= s.in && a <= s.out) accents.push(s.at + a - s.in);
    lastEnd = s.at + (s.out - s.in) - (songs.indexOf(s) < songs.length - 1 ? SONG_CROSSFADE : 0);
  }
  if (!beats.length || beats[0] > 0.05) { beats.unshift(0); sections.add(0); downbeats.add(0); }
  if (beats[beats.length - 1] < total - 0.05) beats.push(total);
  const tempo = songs[0].analysis.tempo || 120;
  const last = songs[songs.length - 1];
  const fadeOutAt = last.at + Math.min(last.out - last.in, Math.max(0, last.analysis.edges.fadeOut - last.in));
  return {
    total, beats, downbeats, sections, accents, tempo, beatLen: 60 / tempo, songs, fadeOutAt,
    sectionAt: (t) => {
      const s = songs.find((x) => t >= x.at && t < x.at + (x.out - x.in));
      if (!s) return undefined;
      const local = t - s.at + s.in;
      return s.analysis.sections.find((x) => local >= x.start && local < x.end);
    },
  };
}

/** Audio events for the songs: trims, fades, equal-power crossfades, loudness normalization. */
export function songEvents(grid: MusicGrid, showDur: number, ducks: [number, number, number][]): AudioEvent[] {
  const target = -16; // LUFS-ish target for all songs
  return grid.songs.map((s, i) => {
    const len = s.out - s.in;
    const gain = Math.pow(10, (Math.min(6, Math.max(-12, target - s.analysis.loudness)) / 20)) * s.ref.gain;
    const pts: [number, number][] = [];
    const fin = i === 0 ? Math.max(s.ref.fadeIn, 0.05) : SONG_CROSSFADE, fout = i === grid.songs.length - 1 ? Math.max(s.ref.fadeOut, 0.05) : SONG_CROSSFADE;
    const end = Math.min(s.at + len, i === grid.songs.length - 1 ? showDur : Infinity);
    pts.push([s.at, 0]);
    pts.push([s.at + fin * 0.5, Math.SQRT1_2 * gain]);
    pts.push([s.at + fin, gain]);
    pts.push([Math.max(s.at + fin, end - fout), gain]);
    pts.push([Math.max(s.at + fin, end - fout * 0.5), Math.SQRT1_2 * gain]);
    pts.push([end, 0]);
    const duck: [number, number][] = [];
    for (const [t0, t1, db] of ducks) {
      const g = Math.pow(10, db / 20);
      duck.push([t0 - 0.3, 1], [t0, g], [t1, g], [t1 + 0.8, 1]);
    }
    return { src: s.ref.hash, at: s.at, in: s.in, out: Math.min(s.out, s.in + (end - s.at)), gain: { points: pts }, duck: duck.length ? { points: duck } : undefined, kind: "song" };
  });
}
