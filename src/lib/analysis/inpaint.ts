// Classical exemplar inpainting for background plates (spec §4.6, M6 without a model).
//
// Coarse-to-fine PatchMatch with patch voting (after Wexler, Shechtman and Irani, "Space-Time
// Completion of Video", and Barnes et al., "PatchMatch"). The hole is filled only with patches
// copied from the photo's own known pixels, so nothing is generated; source patches never overlap
// the hole (the subject and its ring) or any `avoid` mask (faces), so no person's pixels are
// copied into the background (spec §1.2).

const PR = 3;                // patch radius: 7 × 7 patches
const MIN_EDGE = 40;         // the coarsest level keeps at least this long edge
const MAX_LEVELS = 6;
const MIN_SOURCES = 32;      // a level with fewer valid source patches is skipped

interface Level {
  w: number; h: number;
  img: Float32Array;         // interleaved, C channels per pixel
  hole: Uint8Array;          // 1 = unknown
  valid: Uint8Array;         // 1 = a patch centred here lies fully on known, allowed pixels
  sources: Int32Array;       // indices of valid centres
  targets: Int32Array;       // centres whose patch touches the hole
}

/** xorshift32, deterministic so plates are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Sum of `m` over every (2PR+1)² window, via an integral image; `out[i]` = count around i (interior centres only, -1 elsewhere). */
function windowCount(m: Uint8Array, w: number, h: number): Int32Array {
  const W = w + 1, S = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += m[y * w + x]; S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row; }
  }
  const out = new Int32Array(w * h).fill(-1);
  for (let y = PR; y < h - PR; y++) for (let x = PR; x < w - PR; x++) {
    const x0 = x - PR, y0 = y - PR, x1 = x + PR + 1, y1 = y + PR + 1;
    out[y * w + x] = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
  }
  return out;
}

function makeLevel(img: Float32Array, hole: Uint8Array, banned: Uint8Array, w: number, h: number): Level {
  const n = w * h, bad = new Uint8Array(n);
  for (let i = 0; i < n; i++) bad[i] = hole[i] | banned[i];
  const cBad = windowCount(bad, w, h), cHole = windowCount(hole, w, h);
  const valid = new Uint8Array(n), src: number[] = [], tgt: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cBad[i] === 0) { valid[i] = 1; src.push(i); }
    if (cHole[i] > 0) tgt.push(i);
  }
  return { w, h, img, hole, valid, sources: Int32Array.from(src), targets: Int32Array.from(tgt) };
}

function downsample(img: Float32Array, hole: Uint8Array, banned: Uint8Array, w: number, h: number, C: number) {
  const w2 = w >> 1, h2 = h >> 1, n2 = w2 * h2;
  const o = new Float32Array(n2 * C), oh = new Uint8Array(n2), ob = new Uint8Array(n2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const j = y * w2 + x, a = 2 * y * w + 2 * x, ids = [a, a + 1, a + w, a + w + 1];
    for (const i of ids) { oh[j] |= hole[i]; ob[j] |= banned[i]; for (let c = 0; c < C; c++) o[j * C + c] += img[i * C + c] * 0.25; }
  }
  return { img: o, hole: oh, banned: ob, w: w2, h: h2 };
}

/** Fill the hole of `channels` in place. Channels are planar, equally weighted in the patch
 *  distance (scale them before calling to weight them). `hole[i] = 1` marks unknown pixels; the
 *  hole should already hold a rough guess (pull-push), which seeds the coarsest level. Pixels with
 *  `avoid[i] = 1` are never used as sources. Returns false (and leaves the input) when the photo has
 *  too little known area to copy from. */
export function inpaint(channels: Float32Array[], hole: Uint8Array, w: number, h: number, avoid?: Uint8Array, seed = 1): boolean {
  const C = channels.length, n = w * h;
  let holeCount = 0;
  for (let i = 0; i < n; i++) holeCount += hole[i];
  if (!holeCount) return true;
  const img0 = new Float32Array(n * C);
  for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) img0[i * C + c] = channels[c][i];

  // Pyramid, finest first.
  const raw = [{ img: img0, hole, banned: avoid ?? new Uint8Array(n), w, h }];
  while (raw.length < MAX_LEVELS) {
    const t = raw[raw.length - 1];
    if (Math.max(t.w, t.h) / 2 < MIN_EDGE || Math.min(t.w, t.h) / 2 < 4 * PR) break;
    raw.push(downsample(t.img, t.hole, t.banned, t.w, t.h, C));
  }
  const levels = raw.map((r) => makeLevel(r.img, r.hole, r.banned, r.w, r.h));
  let top = levels.length - 1;
  while (top >= 0 && levels[top].sources.length < MIN_SOURCES) top--;
  if (top < 0) return false;

  const rand = rng(seed);
  let prevNnf: Int32Array | null = null, prev: Level | null = null;
  for (let li = top; li >= 0; li--) {
    const L = levels[li], nnf = new Int32Array(L.w * L.h).fill(-1), dist = new Float32Array(L.w * L.h);
    const pick = () => L.sources[(rand() * L.sources.length) | 0];
    for (const p of L.targets) {
      let q = -1;
      if (prevNnf && prev) {
        const px = p % L.w, py = (p / L.w) | 0;
        const cp = Math.min(py >> 1, prev.h - 1) * prev.w + Math.min(px >> 1, prev.w - 1), cq = prevNnf[cp];
        if (cq >= 0) {
          const qx = Math.min(2 * (cq % prev.w) + (px & 1), L.w - 1), qy = Math.min(2 * ((cq / prev.w) | 0) + (py & 1), L.h - 1);
          const qi = qy * L.w + qx;
          if (L.valid[qi]) q = qi;
        }
      }
      nnf[p] = q >= 0 ? q : pick();
    }
    if (prevNnf) vote(L, nnf, dist, C, false);   // seed this level's hole from the coarser match
    const iters = Math.max(2, 7 - 2 * (top - li));
    for (let it = 0; it < iters; it++) {
      for (const p of L.targets) dist[p] = patchDist(L, p, nnf[p], C, Infinity);
      search(L, nnf, dist, C, it % 2 === 1, rand);
      vote(L, nnf, dist, C, true);
    }
    prevNnf = nnf; prev = L;
  }
  const out = levels[0].img;
  for (let i = 0; i < n; i++) if (hole[i]) for (let c = 0; c < C; c++) channels[c][i] = out[i * C + c];
  return true;
}

function patchDist(L: Level, p: number, q: number, C: number, cap: number): number {
  const { w, img } = L;
  let d = 0;
  for (let dy = -PR; dy <= PR; dy++) {
    const pr = (p + dy * w) * C, qr = (q + dy * w) * C;
    for (let k = -PR * C; k < (PR + 1) * C; k++) { const e = img[pr + k] - img[qr + k]; d += e * e; }
    if (d >= cap) return d;
  }
  return d;
}

/** One PatchMatch sweep: propagation from the scan-order neighbours, then random search. */
function search(L: Level, nnf: Int32Array, dist: Float32Array, C: number, reverse: boolean, rand: () => number) {
  const { w, h, targets, valid } = L, T = targets.length, s = reverse ? -1 : 1;
  for (let t = 0; t < T; t++) {
    const p = targets[reverse ? T - 1 - t : t];
    let best = nnf[p], bd = dist[p];
    // Propagation: the neighbour's match, shifted by one.
    for (const nb of [p - s, p - s * w]) {
      const nq = nnf[nb];
      if (nq < 0) continue;
      const c = nb === p - s ? nq + s : nq + s * w;
      if (c < 0 || c >= w * h || !valid[c] || c === best) continue;
      const d = patchDist(L, p, c, C, bd);
      if (d < bd) { bd = d; best = c; }
    }
    // Random search in shrinking windows around the current best.
    const bx = best % w, by = (best / w) | 0;
    for (let r = Math.max(w, h); r >= 1; r >>= 1) {
      const cx = Math.round(bx + (rand() * 2 - 1) * r), cy = Math.round(by + (rand() * 2 - 1) * r);
      if (cx < PR || cy < PR || cx >= w - PR || cy >= h - PR) continue;
      const c = cy * w + cx;
      if (!valid[c]) continue;
      const d = patchDist(L, p, c, C, bd);
      if (d < bd) { bd = d; best = c; }
    }
    nnf[p] = best; dist[p] = bd;
  }
}

/** Each hole pixel becomes the weighted mean of what every overlapping patch's match says it should be. */
function vote(L: Level, nnf: Int32Array, dist: Float32Array, C: number, weighted: boolean) {
  const { w, img, hole, targets } = L, n = L.w * L.h;
  let mean = 0;
  if (weighted) { for (const p of targets) mean += dist[p]; mean = mean / Math.max(1, targets.length) || 1; }
  const acc = new Float32Array(n * C), ws = new Float32Array(n);
  for (const p of targets) {
    const q = nnf[p], wt = weighted ? Math.exp(-dist[p] / mean) + 1e-6 : 1;
    for (let dy = -PR; dy <= PR; dy++) for (let dx = -PR; dx <= PR; dx++) {
      const i = p + dy * w + dx;
      if (!hole[i]) continue;
      const j = (q + dy * w + dx) * C;
      for (let c = 0; c < C; c++) acc[i * C + c] += wt * img[j + c];
      ws[i] += wt;
    }
  }
  for (let i = 0; i < n; i++) if (hole[i] && ws[i] > 0) for (let c = 0; c < C; c++) img[i * C + c] = acc[i * C + c] / ws[i];
}
