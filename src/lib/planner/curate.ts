// Pass 1, curate (spec §5.1) and the curation signals (spec §4.5): duplicate groups with
// complete linkage, best-of-group, quality flags, chapters.
import type { MediaAnalysis } from "./types";

export const PHASH_DUP = 6;             // max Hamming distance of 64 bits for near-duplicates
export const BURST_WINDOW_MS = 10_000;  // same burst means within 10 s of capture time

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Groups of near-duplicates: every pair within threshold (complete linkage) and, when capture
 *  times are known, within the burst window. Returns groups of hashes with 2+ members. */
export function duplicateGroups(items: MediaAnalysis[], threshold = PHASH_DUP): string[][] {
  const xs = items.filter((m) => m.basics?.phash && m.info.kind === "photo");
  const groups: MediaAnalysis[][] = [];
  for (const m of xs) {
    let placed = false;
    for (const g of groups) {
      const fits = g.every((o) => {
        if (hamming(o.basics!.phash, m.basics!.phash) > threshold) return false;
        if (o.info.taken && m.info.taken && Math.abs(o.info.taken - m.info.taken) > BURST_WINDOW_MS) return false;
        return true;
      });
      if (fits) { g.push(m); placed = true; break; }
    }
    if (!placed) groups.push([m]);
  }
  return groups.filter((g) => g.length > 1).map((g) => g.map((m) => m.info.hash));
}

/** Rank within a group: sharpness, eyes open, smile, face size and exposure (spec §4.5). */
export function groupScore(m: MediaAnalysis): number {
  const b = m.basics, faces = m.faces ?? [];
  let s = 0;
  if (b) {
    s += Math.min(1, b.sharpness / 400) * 2;
    s -= Math.abs(b.exposure - 0.5) * 1.5;
    s -= (b.clipped.dark + b.clipped.bright) * 2;
  }
  for (const f of faces) {
    s += 0.5 * Math.min(1, ((f.box[2] - f.box[0]) * (f.box[3] - f.box[1])) / (m.info.w * m.info.h) * 20);
    if (f.eyesOpen !== undefined) s += f.eyesOpen * 0.8;
    if (f.smile !== undefined) s += f.smile * 0.4;
  }
  return s;
}

export interface Curated {
  kept: string[];                  // hashes in input order, duplicates collapsed to their best
  alternates: Record<string, string[]>; // best hash -> the rest of its group
  suggestedOut: Record<string, string>; // hash -> reason
  flipbooks: string[][];           // bursts of 4..15 kept whole for stop-motion
}

export function curate(items: MediaAnalysis[], opts: { includeFlagged?: boolean; flipbooks?: boolean } = {}): Curated {
  const by = new Map(items.map((m) => [m.info.hash, m]));
  const groups = duplicateGroups(items);
  const alternates: Record<string, string[]> = {};
  const drop = new Set<string>();
  const flipbooks: string[][] = [];
  for (const g of groups) {
    if (opts.flipbooks && g.length >= 4 && g.length <= 15) { flipbooks.push(g); continue; }
    const best = [...g].sort((a, b) => groupScore(by.get(b)!) - groupScore(by.get(a)!))[0];
    alternates[best] = g.filter((h) => h !== best);
    for (const h of alternates[best]) drop.add(h);
  }
  const suggestedOut: Record<string, string> = {};
  const kept: string[] = [];
  for (const m of items) {
    if (drop.has(m.info.hash)) continue;
    const flags = m.basics?.flags ?? [];
    const bad = flags.find((f) => f === "blurry" || f === "dark" || f === "blown" || f === "tiny");
    if (bad && !opts.includeFlagged) { suggestedOut[m.info.hash] = REASONS[bad]; continue; }
    kept.push(m.info.hash);
  }
  return { kept, alternates, suggestedOut, flipbooks };
}

const REASONS: Record<string, string> = {
  blurry: "Looks blurry", dark: "Very dark", blown: "Blown-out highlights", tiny: "Low resolution for this output", screenshot: "Screenshot or document",
};

/** Chapter starts: capture-time gaps over an adaptive threshold (90th percentile, at least 2 h)
 *  or GPS jumps over 20 km (spec §4.5). Returns the chapter index per item in the given order. */
export function chapters(items: MediaAnalysis[]): number[] {
  const times = items.map((m) => m.info.taken ?? null);
  const gaps: number[] = [];
  for (let i = 1; i < items.length; i++) if (times[i] && times[i - 1]) gaps.push(Math.abs(times[i]! - times[i - 1]!));
  const sorted = [...gaps].sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : 0;
  const threshold = Math.max(p90, 2 * 3600_000);
  const out: number[] = [];
  let ch = 0;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const dt = times[i] && times[i - 1] ? Math.abs(times[i]! - times[i - 1]!) : 0;
      const a = items[i].info.gps, b = items[i - 1].info.gps;
      const jump = a && b ? haversineKm(a, b) > 20 : false;
      if (dt > threshold || jump) ch++;
    }
    out.push(ch);
  }
  return out;
}

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
