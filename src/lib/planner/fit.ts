// Pass 5, fit to music (spec §5.5): dynamic programming over the beat grid. Choose cut beats
// b0 < b1 < … < bn minimizing Σ (ln(actual/desired))² + λ1·[not a downbeat] + λ2·[major cut not
// on a section boundary] − λ3·[chapter change on a section boundary], each actual in
// [0.6, 1.6] × desired (locked durations fixed), ending exactly on the last beat.

export interface FitSlide { desired: number; locked?: number; major?: boolean; min?: number }
export interface FitGrid { beats: number[]; downbeats: Set<number>; sections: Set<number> } // indices into beats
export interface FitResult { starts: number[]; durs: number[]; cost: number; ok: boolean; need: number; have: number }

const L1 = 0.08, L2 = 0.5, L3 = 0.4;
const LO = 0.6, HI = 1.6;

export function fitToBeats(slides: FitSlide[], grid: FitGrid, opts: { window?: number; snapOnly?: boolean } = {}): FitResult {
  const n = slides.length, beats = grid.beats, nb = beats.length;
  const need = slides.reduce((s, x) => s + (x.locked ?? x.desired), 0);
  const have = nb ? beats[nb - 1] - beats[0] : 0;
  if (!n || nb < 2) return { starts: [], durs: [], cost: Infinity, ok: false, need, have };
  // Expected end beat of slide i if everything went to plan, to centre the search windows.
  const cum: number[] = [0];
  for (const s of slides) cum.push(cum[cum.length - 1] + (s.locked ?? s.desired));
  const scale = have / Math.max(need, 1e-6);
  const W = opts.window ?? 48;
  const INF = Infinity;
  // dp[i][j]: best cost with slides 0..i-1 placed and slide i starting at beat j. Store per slide a map beat -> {cost, prev}.
  let prev = new Map<number, { cost: number; from: number }>([[0, { cost: 0, from: -1 }]]);
  const links: Map<number, { cost: number; from: number }>[] = [prev];
  const idxNear = (t: number) => {
    let lo = 0, hi = nb - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };
  for (let i = 0; i < n; i++) {
    const s = slides[i], cur = new Map<number, { cost: number; from: number }>();
    const want = s.locked ?? s.desired;
    const lo = s.locked ? s.locked * 0.98 : Math.max(s.min ?? 0.4, want * LO), hi = s.locked ? s.locked * 1.02 + 0.05 : want * HI;
    const last = i === n - 1;
    for (const [j, st] of prev) {
      if (st.cost === INF) continue;
      const t0 = beats[j];
      // Candidate end beats within the duration bounds, limited to a window around the expected end.
      const centre = idxNear(beats[0] + cum[i + 1] * scale);
      const kLo = Math.max(j + 1, idxNear(t0 + lo), centre - W), kHi = Math.min(nb - 1, idxNear(t0 + hi), centre + W);
      for (let k = kLo; k <= kHi; k++) {
        if (last && k !== nb - 1) continue;
        const act = beats[k] - t0;
        if (act < lo - 1e-6 || act > hi + 1e-6) continue;
        let c = st.cost + Math.log(act / want) ** 2;
        if (!grid.downbeats.has(k) && !last) c += L1;
        if (s.major && !grid.sections.has(k) && !last) c += L2;
        if (s.major && grid.sections.has(k)) c -= L3;
        const have2 = cur.get(k);
        if (!have2 || c < have2.cost) cur.set(k, { cost: c, from: j });
      }
      if (last) {
        // The last slide must end on the final beat; allow it even when outside the bounds, at a price.
        const act = beats[nb - 1] - t0;
        if (act > 0.3) {
          const c = st.cost + Math.log(act / want) ** 2 + (act < lo || act > hi ? 2 : 0);
          const have2 = cur.get(nb - 1);
          if (!have2 || c < have2.cost) cur.set(nb - 1, { cost: c, from: j });
        }
      }
    }
    links.push(cur);
    prev = cur;
    if (!cur.size) break;
  }
  const end = links[n]?.get(nb - 1);
  if (!end) return { starts: [], durs: [], cost: INF, ok: false, need, have };
  const cuts: number[] = [nb - 1];
  let j = nb - 1;
  for (let i = n; i >= 1; i--) { j = links[i].get(j)!.from; cuts.push(j); }
  cuts.reverse();
  const starts = cuts.slice(0, n).map((k) => beats[k] - beats[0]);
  const durs = starts.map((s, i) => (cuts[i + 1] !== undefined ? beats[cuts[i + 1]] - beats[0] - s : 0));
  // Within bounds for every slide?
  const ok = slides.every((s, i) => { const w = s.locked ?? s.desired; return durs[i] >= w * LO - 1e-6 && durs[i] <= w * HI + 1e-6; });
  return { starts, durs, cost: end.cost, ok, need, have };
}

/** Free mode: durations as desired, cut times snapped to the nearest beat (spec §5.5). */
export function snapToBeats(durs: number[], beats: number[], snap: boolean): { starts: number[]; durs: number[] } {
  const starts: number[] = [];
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < durs.length; i++) {
    starts.push(t);
    let end = t + durs[i];
    if (snap && beats.length) {
      let best = end, bd = Infinity;
      for (const b of beats) { const d = Math.abs(b - end); if (d < bd && b > t + 0.4) { bd = d; best = b; } }
      if (bd < durs[i] * 0.3) end = best;
    }
    out.push(end - t);
    t = end;
  }
  return { starts, durs: out };
}
