// Pass 2, order (spec §5.2): chronological, story, as imported, shuffle; plus the variety rules.
import type { Prng } from "$lib/util/prng";
import { chapters, hamming } from "./curate";
import type { MediaAnalysis, OrderMode } from "./types";

export interface Ordered { hashes: string[]; chapter: number[] }

export function order(mode: OrderMode, hashes: string[], by: Map<string, MediaAnalysis>, rng: Prng, featured?: string): Ordered {
  const items = hashes.map((h) => by.get(h)!).filter(Boolean);
  let seq: MediaAnalysis[];
  switch (mode) {
    case "manual": seq = items; break;
    case "shuffle": seq = rng.shuffle([...items]); break;
    case "time": seq = byTime(items); break;
    case "story": seq = story(byTime(items), rng); break;
  }
  seq = variety(seq, featured);
  const ch = mode === "shuffle" || mode === "manual" ? seq.map(() => 0) : chapters(seq);
  return { hashes: seq.map((m) => m.info.hash), chapter: ch };
}

const byTime = (items: MediaAnalysis[]) => [...items].sort((a, b) => (a.info.taken ?? Infinity) - (b.info.taken ?? Infinity));

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Story order: chronological at the chapter level; inside a chapter an establishing shot first,
 *  groups near the ends, close-ups between, walking a nearest-neighbour path in embedding space. */
function story(items: MediaAnalysis[], rng: Prng): MediaAnalysis[] {
  const ch = chapters(items);
  const out: MediaAnalysis[] = [];
  let i = 0;
  while (i < items.length) {
    let j = i;
    while (j < items.length && ch[j] === ch[i]) j++;
    out.push(...storyChapter(items.slice(i, j), rng));
    i = j;
  }
  return out;
}

function storyChapter(items: MediaAnalysis[], rng: Prng): MediaAnalysis[] {
  if (items.length <= 3) return items;
  const faceCount = (m: MediaAnalysis) => m.faces?.length ?? 0;
  const largestFace = (m: MediaAnalysis) => Math.max(0, ...(m.faces ?? []).map((f) => (f.box[3] - f.box[1]) / m.info.h));
  const establishing = (m: MediaAnalysis) => {
    const t = m.tags ?? {};
    return (t.landscape ?? 0) + (t.cityscape ?? 0) + (t.beach ?? 0) + (faceCount(m) === 0 ? 0.5 : largestFace(m) < 0.1 ? 0.2 : -1) + (m.basics ? Math.min(1, m.basics.sharpness / 400) * 0.3 : 0);
  };
  const pool = [...items];
  const open = pool.splice(pool.map((m, k) => [establishing(m), k] as const).sort((a, b) => b[0] - a[0])[0][1], 1)[0];
  const groups = pool.filter((m) => faceCount(m) >= 3);
  const closeGroup = groups.length ? pool.splice(pool.indexOf(groups[groups.length - 1]), 1)[0] : null;
  const openGroup = groups.length > 1 ? pool.splice(pool.indexOf(groups[0]), 1)[0] : null;
  // Greedy nearest-neighbour walk through the middle.
  const middle: MediaAnalysis[] = [];
  let cur = openGroup ?? open;
  while (pool.length) {
    let bi = 0, bs = -Infinity;
    for (let k = 0; k < pool.length; k++) {
      const e1 = cur.embedding, e2 = pool[k].embedding;
      const s = e1 && e2 && e1.length === e2.length ? dot(e1, e2) : -((pool[k].info.taken ?? 0) - (cur.info.taken ?? 0)) / 1e9 + rng.next() * 1e-3;
      if (s > bs) { bs = s; bi = k; }
    }
    cur = pool.splice(bi, 1)[0];
    middle.push(cur);
  }
  return [open, ...(openGroup ? [openGroup] : []), ...middle, ...(closeGroup ? [closeGroup] : [])];
}

/** Variety: no two near-duplicates adjacent; no single person more than 4 in a row unless featured. */
function variety(seq: MediaAnalysis[], featured?: string): MediaAnalysis[] {
  const out = [...seq];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const dup = a.basics?.phash && b.basics?.phash && hamming(a.basics.phash, b.basics.phash) <= 10;
    const run = b.personId && b.personId !== featured && countRun(out, i, b.personId) > 4;
    if (dup || run) {
      // Swap with the next item that breaks the problem, if any.
      for (let j = i + 1; j < Math.min(out.length, i + 8); j++) {
        const c = out[j];
        const cdup = a.basics?.phash && c.basics?.phash && hamming(a.basics.phash, c.basics.phash) <= 10;
        if (!cdup && (!c.personId || c.personId !== b.personId)) { [out[i], out[j]] = [out[j], out[i]]; break; }
      }
    }
  }
  return out;
}

function countRun(seq: MediaAnalysis[], i: number, person: string): number {
  let n = 0;
  for (let k = i; k >= 0 && seq[k].personId === person; k--) n++;
  return n;
}
