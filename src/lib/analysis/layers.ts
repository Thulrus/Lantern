// Subject and background layers from a depth map (spec §4.6, §9.2), with no extra model: the
// subject layer is the near side of a soft depth threshold between the subject's depth and its
// surroundings, the hole it leaves is filled by a classical pull-push pyramid (the no-model
// fallback for plates), and the background depth is filled the same way so the far layer has a
// smooth surface behind the subject. Pure typed-array maths, unit-tested in Node.
//
// Why a depth threshold works as a matte here: both layers displace by their own depth, and at
// the threshold both sides have the same depth, so a seam through a continuous surface (a floor
// the subject stands on) does not open up; only a real depth jump (the silhouette) separates the
// layers, which is exactly where a single mesh would tear.
import { inpaint } from "./inpaint";
import type { Box } from "$lib/planner/types";

export const SEP_MIN = 0.06;              // below this subject separation, one layer is better
const COVER_MIN = 0.004, COVER_MAX = 0.72; // subject share of the frame outside which layering is pointless
const DEPTH_PATCH_W = 255;               // depth (0–1) weighs like one colour channel in patch matching
const HOLE_GROW = 0.008;                   // hole radius past the subject, share of the long edge (a wider ring showed more of the blurry fill)
const FEATHER = 0.015;                     // grown-alpha feather past the hole, share of the long edge
const SMOOTH_BG = 0.006, SMOOTH_FLAT = 0.015, SMOOTH_SUBJECT = 0.008; // Gaussian sigma for layer geometry, share of the long edge

export interface Layers {
  /** Subject alpha planes at map resolution: `tight` hugs the depth edge, `grown` covers the hole
   *  and feathers out, so a still frame composites back to the exact photo. Both empty (all zero)
   *  when there is no subject layer. */
  tight: Uint8Array; grown: Uint8Array;
  /** Background plate, RGBA: the photo with the hole filled; alpha = hole coverage. Null when there is no subject layer. */
  plate: Uint8ClampedArray<ArrayBuffer> | null;
  /** Background geometry depth, full frame, smoothed (the hole filled from its surroundings). */
  bgDepth: Uint16Array;
  /** Subject layer summary for the planner; null when there is no subject layer. */
  matte: { tau: number; floor: number; cover: number; sep: number; pivot: number; box: Box } | null;  // box: the largest near blob's bounds, map px
}

/** Separable Gaussian blur of a float plane, edge-clamped. */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; s += src[row + xx] * k[i + r]; }
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; s += tmp[yy * w + x] * k[i + r]; }
      out[y * w + x] = s;
    }
  return out;
}

/** Distance (pixels, chamfer 1/√2) from every pixel to the nearest pixel where `inside` is set; 0 inside. */
export function distanceOutside(inside: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9, d = new Float32Array(w * h), D = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

/** Pull-push fill (Gortler et al.): pixels with weight 0 are filled from the known ones through
 *  an image pyramid, so a hole takes the colours of its rim, blended smoothly across its width.
 *  All channels share the weights; they are filled in place. */
export function pullPush(channels: Float32Array[], weight: Float32Array, w: number, h: number): void {
  const C = channels.length;
  const levels: { c: Float32Array[]; wt: Float32Array; w: number; h: number }[] = [{ c: channels, wt: weight, w, h }];
  // Pull: weighted 2×2 averages up to a single pixel.
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const W = Math.ceil(f.w / 2), H = Math.ceil(f.h / 2);
    const c = channels.map(() => new Float32Array(W * H)), wt = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let sw = 0;
        const acc = new Array<number>(C).fill(0);
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(f.w - 1, 2 * x + dx), sy = Math.min(f.h - 1, 2 * y + dy), si = sy * f.w + sx, ww = f.wt[si];
            if (!ww) continue;
            sw += ww;
            for (let k = 0; k < C; k++) acc[k] += ww * f.c[k][si];
          }
        const o = y * W + x;
        wt[o] = Math.min(1, sw / 4);
        if (sw) for (let k = 0; k < C; k++) c[k][o] = acc[k] / sw;
      }
    levels.push({ c, wt, w: W, h: H });
  }
  // Push: fill the unknown share of each level from the level above, bilinearly upsampled.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], g = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const gy = Math.min(g.h - 1, Math.max(0, (y - 0.5) / 2)), y0 = Math.floor(gy), y1 = Math.min(g.h - 1, y0 + 1), fy = gy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x, ww = f.wt[i];
        if (ww >= 1) continue;
        const gx = Math.min(g.w - 1, Math.max(0, (x - 0.5) / 2)), x0 = Math.floor(gx), x1 = Math.min(g.w - 1, x0 + 1), fx = gx - x0;
        const i00 = y0 * g.w + x0, i01 = y0 * g.w + x1, i10 = y1 * g.w + x0, i11 = y1 * g.w + x1;
        for (let k = 0; k < C; k++) {
          const up = (g.c[k][i00] * (1 - fx) + g.c[k][i01] * fx) * (1 - fy) + (g.c[k][i10] * (1 - fx) + g.c[k][i11] * fx) * fy;
          f.c[k][i] = ww * f.c[k][i] + (1 - ww) * up;
        }
        f.wt[i] = 1;
      }
    }
  }
}

/** Median of the values where `mask` holds (sampled when large). */
function medianWhere(v: Float32Array, pick: (i: number) => boolean): number {
  const step = Math.max(1, Math.floor(v.length / 60000)), xs: number[] = [];
  for (let i = 0; i < v.length; i += step) if (pick(i)) xs.push(v[i]);
  if (!xs.length) return NaN;
  const s = Float32Array.from(xs).sort();
  return s[s.length >> 1];
}

/** The depth threshold between subject and surroundings: the emptiest histogram bin between the
 *  two medians (a valley), falling back to the point 40% of the way from background to subject. */
export function subjectThreshold(d: Float32Array, subjectMedian: number, bgMedian: number): number {
  const lo = Math.min(subjectMedian, bgMedian), hi = Math.max(subjectMedian, bgMedian);
  const fallback = bgMedian + 0.4 * (subjectMedian - bgMedian);
  if (hi - lo < 1e-3) return fallback;
  const B = 48, hist = new Float32Array(B);
  const step = Math.max(1, Math.floor(d.length / 200000));
  for (let i = 0; i < d.length; i += step) {
    const b = Math.floor(((d[i] - lo) / (hi - lo)) * B);
    if (b >= 0 && b < B) hist[b]++;
  }
  // Smooth a little, then take the middle of the widest run of emptiest bins in the middle 60% of the span.
  const sm = new Float32Array(B);
  for (let i = 0; i < B; i++) sm[i] = (hist[Math.max(0, i - 1)] + 2 * hist[i] + hist[Math.min(B - 1, i + 1)]) / 4;
  const i0 = Math.floor(B * 0.2), i1 = Math.ceil(B * 0.8);
  let mv = Infinity;
  for (let i = i0; i < i1; i++) mv = Math.min(mv, sm[i]);
  const tol = mv + 0.02 * (d.length / step) / B;
  let best = -1, bestLen = 0;
  for (let i = i0; i < i1; i++) {
    if (sm[i] > tol) continue;
    let j = i;
    while (j + 1 < i1 && sm[j + 1] <= tol) j++;
    if (j - i + 1 > bestLen) { bestLen = j - i + 1; best = (i + j) / 2; }
    i = j;
  }
  if (best < 0) return fallback;
  return lo + ((best + 0.5) / B) * (hi - lo);
}

/** Otsu's threshold on the depth histogram: the split that best separates a near and a far class.
 *  Returns the threshold and the two class means. */
export function otsu(d: Float32Array): { tau: number; near: number; far: number; cover: number } {
  const B = 64, hist = new Float64Array(B);
  const step = Math.max(1, Math.floor(d.length / 200000));
  let n = 0;
  for (let i = 0; i < d.length; i += step) { hist[Math.min(B - 1, Math.max(0, Math.floor(d[i] * B)))]++; n++; }
  let sumAll = 0;
  for (let b = 0; b < B; b++) sumAll += b * hist[b];
  let w0 = 0, sum0 = 0, best = 0, bt = B >> 1;
  for (let b = 0; b < B - 1; b++) {
    w0 += hist[b]; sum0 += b * hist[b];
    const w1 = n - w0;
    if (!w0 || !w1) continue;
    const m0 = sum0 / w0, m1 = (sumAll - sum0) / w1, v = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (v > best) { best = v; bt = b; }
  }
  let c0 = 0, s0 = 0, c1 = 0, s1 = 0;
  for (let b = 0; b < B; b++) { if (b <= bt) { c0 += hist[b]; s0 += b * hist[b]; } else { c1 += hist[b]; s1 += b * hist[b]; } }
  return { tau: (bt + 1) / B, far: c0 ? (s0 / c0 + 0.5) / B : 0, near: c1 ? (s1 / c1 + 0.5) / B : 1, cover: c1 / Math.max(1, n) };
}

/** Build the two layers for a photo. `px` is the photo at map size (RGBA), `u16` the normalised
 *  depth, `subject` the subject box in map pixels (null when nothing was found), `subjectMedian`
 *  and `bgMedian` the planner's inverse-depth medians inside and outside it. */
export function buildLayers(px: Uint8ClampedArray, u16: Uint16Array, w: number, h: number, subject: Box | null, subjectMedian: number, bgMedian: number, avoid: Box[] = [], people: Uint8Array | null = null): Layers {
  const n = w * h, long = Math.max(w, h);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = u16[i] / 65535;
  const tight = new Uint8Array(n), grown = new Uint8Array(n);
  const flat = (): Layers => ({ tight, grown, plate: null, bgDepth: toU16(gaussianBlur(d, w, h, SMOOTH_FLAT * long)), matte: null });
  let sep = subjectMedian - bgMedian, tau: number;
  if (subject && sep >= SEP_MIN) tau = subjectThreshold(d, subjectMedian, bgMedian);
  else {
    // No usable subject box: split near from far where the depth histogram itself does, if the
    // near class is a compact minority with a clear gap (a pet, a statue, a person missed by the detector).
    const o = otsu(d);
    if (o.near - o.far < 0.3 || o.cover < COVER_MIN || o.cover > 0.45) return flat();
    tau = o.tau; sep = o.near - o.far; subjectMedian = o.near; bgMedian = o.far;
  }

  // Soft threshold in depth: alpha ramps over a band around tau.
  const delta = Math.max(0.012, 0.07 * sep), floor = tau - delta;
  const tightF = new Float32Array(n);
  let cover = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (d[i] - floor) / (2 * delta)));
    const a = t * t * (3 - 2 * t);
    tightF[i] = a; cover += a;
  }
  if (people) { wholePeople(tightF, people, w, h); cover = 0; for (let i = 0; i < n; i++) cover += tightF[i]; }
  cover /= n;
  if (cover < COVER_MIN || cover > COVER_MAX) return flat();

  // Hole = the subject grown; grown alpha = 1 over the hole, feathered outside it.
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = tightF[i] > 0.02 ? 1 : 0;
  const dist = distanceOutside(inside, w, h);
  const rHole = HOLE_GROW * long, rFeather = Math.max(2, FEATHER * long);
  const known = new Float32Array(n);
  const plate = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const inHole = dist[i] <= rHole;
    known[i] = inHole ? 0 : 1;
    tight[i] = Math.round(tightF[i] * 255);
    grown[i] = Math.round(Math.min(1, Math.max(0, (rHole + 2 + rFeather - dist[i]) / rFeather)) * 255);
    plate[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, (rHole + 2 - dist[i]) / 2)) * 255);
  }
  // Fill colour and depth behind the subject from the rim of the hole.
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), bd = new Float32Array(n);
  for (let i = 0; i < n; i++) { r[i] = px[i * 4]; g[i] = px[i * 4 + 1]; b[i] = px[i * 4 + 2]; bd[i] = d[i]; }
  pullPush([r, g, b, bd], known, w, h);
  // Refine the blurry rim fill with patches copied from the photo's own background (no faces).
  const hole = new Uint8Array(n), ban = new Uint8Array(n);
  for (let i = 0; i < n; i++) { hole[i] = known[i] ? 0 : 1; bd[i] *= DEPTH_PATCH_W; }
  for (const [x0, y0, x1, y1] of avoid) {
    const m = 0.25 * Math.max(x1 - x0, y1 - y0);
    for (let y = Math.max(0, Math.floor(y0 - m)); y < Math.min(h, Math.ceil(y1 + m)); y++)
      for (let x = Math.max(0, Math.floor(x0 - m)); x < Math.min(w, Math.ceil(x1 + m)); x++) ban[y * w + x] = 1;
  }
  if (people) for (let i = 0; i < n; i++) if (people[i] >= 96) ban[i] = 1;   // never copy anyone's pixels into the background
  inpaint([r, g, b, bd], hole, w, h, ban);
  for (let i = 0; i < n; i++) bd[i] /= DEPTH_PATCH_W;
  for (let i = 0; i < n; i++) { plate[i * 4] = r[i]; plate[i * 4 + 1] = g[i]; plate[i * 4 + 2] = b[i]; }
  const bgDepth = toU16(gaussianBlur(bd, w, h, SMOOTH_BG * long));
  // Separation measured on the matte itself (subject median minus the rest).
  const sm = medianWhere(d, (i) => tightF[i] > 0.5), bm = medianWhere(d, (i) => tightF[i] < 0.5);
  const sep2 = Number.isFinite(sm) && Number.isFinite(bm) ? sm - bm : sep;
  return { tight, grown, plate, bgDepth, matte: { tau, floor, cover, sep: sep2, pivot: Number.isFinite(sm) ? sm : subjectMedian, box: largestBlob(tight, w, h) } };
}

/** Keep whole people on one layer (spec §1.2, §4.6). A depth threshold slices a person whose body
 *  spans depths (seated, partly behind someone): each connected blob of the person mask (0–255,
 *  map size) joins the subject when the matte already holds at least half of it, and leaves the
 *  matte entirely (with a small margin) otherwise. Touching people form one blob and move together. */
export function wholePeople(alpha: Float32Array, people: Uint8Array, w: number, h: number): void {
  const n = w * h, label = new Int32Array(n).fill(-1), stack: number[] = [];
  const minSize = 0.001 * n;
  let next = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (people[s0] < 128 || label[s0] >= 0) continue;
    const comp: number[] = [];
    label[s0] = next; stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!; comp.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
        if (j >= 0 && j < n && label[j] < 0 && people[j] >= 128) { label[j] = next; stack.push(j); }
    }
    next++;
    if (comp.length < minSize) continue;
    let held = 0;
    for (const i of comp) held += alpha[i];
    if (held / comp.length >= 0.5) {
      for (const i of comp) alpha[i] = Math.max(alpha[i], 1);
      // The soft rim of the mask just outside the blob.
      for (const i of comp) {
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
          if (j >= 0 && j < n && people[j] < 128) alpha[j] = Math.max(alpha[j], people[j] / 255);
      }
    } else {
      const r = 2;
      for (const i of comp) {
        const x = i % w, y = (i / w) | 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) alpha[yy * w + xx] = 0;
        }
      }
    }
  }
}

function toU16(f: Float32Array): Uint16Array {
  const out = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(65535, Math.round(f[i] * 65535)));
  return out;
}

/** The renderer's maps texture (RGBA float): R = background geometry depth, G = subject geometry
 *  depth, B = grown alpha, A = tight alpha. The subject depth is extended past the matte (pull-push
 *  with the matte as the weights) so the subject mesh stays smooth across its silhouette and only
 *  the alpha cuts it; a mesh that dropped to the far depth outside the matte stretched its edge
 *  triangles into a sawtooth. */
export function composeMaps(depth: Uint16Array, bgDepth: Uint16Array, matte: { tight: Uint8Array; grown: Uint8Array } | null, w: number, h: number): Float32Array {
  const n = w * h, out = new Float32Array(n * 4);
  let subj: Float32Array | null = null;
  if (matte) {
    subj = new Float32Array(n);
    const wt = new Float32Array(n);
    for (let i = 0; i < n; i++) { subj[i] = depth[i] / 65535; wt[i] = matte.tight[i] / 255; }
    pullPush([subj], wt, w, h);
    // Several subjects at different depths share this layer; smoothing turns the step between
    // them from a sawtooth of stretched triangles into a gentle warp.
    subj = gaussianBlur(subj, w, h, SMOOTH_SUBJECT * Math.max(w, h));
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const bg = bgDepth[i] / 65535;
    out[j] = bg;
    out[j + 1] = subj ? subj[i] : bg;
    out[j + 2] = matte ? matte.grown[i] / 255 : 0;
    out[j + 3] = matte ? matte.tight[i] / 255 : 0;
  }
  return out;
}

/** Bounds of the largest connected region with alpha > 0.5 (4-connected), in map pixels.
 *  The planner uses it as the focal subject when a photo has no faces. */
export function largestBlob(alpha: Uint8Array, w: number, h: number): Box {
  const seen = new Uint8Array(w * h), stack: number[] = [];
  let best: Box = [0, 0, w, h], bestN = 0;
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || alpha[i] < 128) continue;
    let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[j - 1] && alpha[j - 1] >= 128) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < w - 1 && !seen[j + 1] && alpha[j + 1] >= 128) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && !seen[j - w] && alpha[j - w] >= 128) { seen[j - w] = 1; stack.push(j - w); }
      if (y < h - 1 && !seen[j + w] && alpha[j + w] >= 128) { seen[j + w] = 1; stack.push(j + w); }
    }
    if (n > bestN) { bestN = n; best = [x0, y0, x1 + 1, y1 + 1]; }
  }
  return best;
}
