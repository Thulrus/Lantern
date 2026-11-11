// Pass 3, group (spec §5.3): diptychs of two portraits, flipbooks, title cards.
import type { Aspect, MediaAnalysis } from "./types";

export interface GroupedItem { kind: "photo" | "video" | "pair" | "flipbook"; items: string[]; chapter: number }

const PAIR_WINDOW_MS = 30 * 60_000;

export function group(hashes: string[], chapter: number[], by: Map<string, MediaAnalysis>, aspect: Aspect, flipbooks: string[][], allowPairs: boolean): GroupedItem[] {
  const out: GroupedItem[] = [];
  const inFlip = new Map<string, string[]>();
  for (const f of flipbooks) for (const h of f) inFlip.set(h, f);
  const done = new Set<string>();
  const landscapeShow = aspect === "16:9" || aspect === "21:9";
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (done.has(h)) continue;
    const m = by.get(h);
    if (!m) continue;
    const flip = inFlip.get(h);
    if (flip) {
      const members = flip.filter((x) => !done.has(x));
      members.forEach((x) => done.add(x));
      out.push({ kind: "flipbook", items: members, chapter: chapter[i] });
      continue;
    }
    if (m.info.kind === "video") { done.add(h); out.push({ kind: "video", items: [h], chapter: chapter[i] }); continue; }
    const portrait = m.info.h > m.info.w * 1.15;
    if (allowPairs && landscapeShow && portrait) {
      // A neighbouring portrait in the same chapter and within 30 minutes shares the slide.
      for (let j = i + 1; j < Math.min(hashes.length, i + 4); j++) {
        const n = by.get(hashes[j]);
        if (!n || done.has(hashes[j]) || n.info.kind !== "photo" || inFlip.has(hashes[j])) continue;
        if (chapter[j] !== chapter[i] || n.info.h <= n.info.w * 1.15) continue;
        const dt = m.info.taken && n.info.taken ? Math.abs(m.info.taken - n.info.taken) : 0;
        if (dt > PAIR_WINDOW_MS) continue;
        done.add(h); done.add(hashes[j]);
        out.push({ kind: "pair", items: [h, hashes[j]], chapter: chapter[i] });
        break;
      }
      if (done.has(h)) continue;
    }
    done.add(h);
    out.push({ kind: "photo", items: [h], chapter: chapter[i] });
  }
  return out;
}
