// Pass 7, transitions (spec §5.7): major transitions on section boundaries and chapter changes,
// minor ones inside sections; length in beats.
import type { Prng } from "$lib/util/prng";
import type { Style, TransitionId } from "./types";

const AVAILABLE_2D = new Set<TransitionId>(["cut", "crossfade", "dipBlack", "dipWhite", "push", "whip"]);
const NEEDS_DEPTH = new Set<TransitionId>(["depthWipe", "flyThrough"]);

export interface TransitionContext {
  major: boolean; first: boolean; flipbook: boolean; beat: number; tempoFast: boolean; hasDepth: boolean; hasMusic: boolean; prevType?: TransitionId;
}

export function chooseTransition(style: Style, rng: Prng, c: TransitionContext): { type: TransitionId; dur: number; reason: string } {
  const beat = c.beat > 0 ? c.beat : 0.5;
  if (c.first) return { type: "dipBlack", dur: Math.min(1.2, beat * 2), reason: "opening fade" };
  if (c.flipbook) return { type: "cut", dur: 0, reason: "flipbook" };
  const table = c.major ? style.transitionWeights.major : style.transitionWeights.minor;
  const ids: TransitionId[] = [], ws: number[] = [];
  for (const [id, w] of Object.entries(table) as [TransitionId, number][]) {
    if (!w) continue;
    if (NEEDS_DEPTH.has(id) && !c.hasDepth) continue;
    if (!AVAILABLE_2D.has(id) && !NEEDS_DEPTH.has(id)) continue;
    ids.push(id); ws.push(id === c.prevType && !c.major ? w * 0.5 : w);
  }
  if (!ids.length) return { type: "crossfade", dur: style.crossfade, reason: "default" };
  const type = ids[rng.weighted(ws)];
  let dur: number;
  if (type === "cut") dur = 0;
  else if (type === "whip" || type === "push") dur = c.hasMusic ? beat * 0.5 : 0.35;
  else if (type === "dipBlack" || type === "dipWhite") dur = c.hasMusic ? beat * (c.tempoFast ? 2 : 1) * 1.5 : style.crossfade * 1.2;
  else dur = c.hasMusic ? beat * (c.tempoFast ? 2 : 1) : style.crossfade;
  dur = Math.min(dur, 3);
  return { type, dur, reason: c.major ? "section change" : "within section" };
}
