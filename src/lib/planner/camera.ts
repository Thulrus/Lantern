// The camera model (spec §9.1), shared by the planner and the renderer.
//
// Coordinates are normalized to the image height and centred: u = (x - w/2) / h, v = (y - h/2) / h,
// so the image spans u in [-ia/2, ia/2] (ia = w / h) and v in [-0.5, 0.5]. Depth d is inverse
// depth (1 = near). Each key scales depth about the pivot, d' = dp + ds (d - dp): ds = 0 is the
// flat photo, ds = 1 the measured depth. Distance Z = 1 / (Z_FAR + (1 - Z_FAR) d'). A pixel is
// the 3D point P = (u Z, v Z, Z). The camera at C with focal scale f turns to aim at the aim
// point A (look-at with blend k: k = 0 a plain camera move, k = 1 an orbit that keeps the aim
// point fixed). A point projects to s = f Q.xy / Q.z with Q = R (P - C). `view` [vx, vy, vs]
// then frames the projected image: the screen shows height vs centred on (vx, vy).
//
// 2D Ken Burns is the same model with ds = 0, so every move shares one code path, one easing
// system and one edge-safety check.
import { clamp, lerp, smooth } from "$lib/util/math";
import type { CamKey } from "./types";

export const Z_FAR = 0.25;              // inverse distance of the farthest plane: a 4:1 depth range
export const D_MIN = -0.25, D_MAX = 1.5;  // scaled inverse depth stays in this range
export const BORDER_N = 24;             // depth samples per image side for edge checks

export type V3 = [number, number, number];
export type Bounds = [number, number, number, number]; // lo_u, hi_u, lo_v, hi_v

export const zOf = (d: number) => 1 / (Z_FAR + (1 - Z_FAR) * clamp(d, D_MIN, D_MAX));

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Smallest rotation (row-major 3x3) taking the direction from c to `aim` to the direction from c0. */
export function aimRotation(aim: V3, c: V3, c0: V3): number[] {
  const a = normalize(sub(aim, c)), b = normalize(sub(aim, c0));
  const v: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = 1 / (1 + dot);
  const X = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  const r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let xx = 0;
      for (let n = 0; n < 3; n++) xx += X[i * 3 + n] * X[n * 3 + j];
      r[i * 3 + j] += X[i * 3 + j] + xx * k;
    }
  return r;
}

/** Screen position of an image point (u, v) at inverse depth d. */
export function project(u: number, v: number, d: number, cam: V3, f: number, rot: number[], dp: number, ds: number): [number, number] {
  const z = zOf(dp + ds * (d - dp));
  const p0 = u * z - cam[0], p1 = v * z - cam[1], p2 = z - cam[2];
  const qz = rot[6] * p0 + rot[7] * p1 + rot[8] * p2;
  return [(f * (rot[0] * p0 + rot[1] * p1 + rot[2] * p2)) / qz, (f * (rot[3] * p0 + rot[4] * p1 + rot[5] * p2)) / qz];
}

/** Keyframe segment at x in [0, 1] and its eased progress. */
export function seg(ts: number[], x: number): [number, number] {
  if (ts.length < 2 || x <= ts[0]) return [0, 0];
  for (let i = 0; i < ts.length - 1; i++)
    if (x < ts[i + 1]) return [i, smooth((x - ts[i]) / Math.max(ts[i + 1] - ts[i], 1e-6))];
  return [ts.length - 2, 1];
}

export interface CamState { cam: V3; f: number; ds: number; view: V3 }

/** Interpolated camera at slide-relative time x in [0, 1]. */
export function cameraAt(keys: CamKey[], x: number): CamState {
  if (!keys.length) return { cam: [0, 0, 0], f: 1, ds: 0, view: [0, 0, 1] };
  const [i, e] = seg(keys.map((k) => k.t), x);
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  return {
    cam: [lerp(a.cam[0], b.cam[0], e), lerp(a.cam[1], b.cam[1], e), lerp(a.cam[2], b.cam[2], e)],
    f: lerp(a.f, b.f, e),
    ds: lerp(a.ds, b.ds, e),
    view: [lerp(a.view[0], b.view[0], e), lerp(a.view[1], b.view[1], e), lerp(a.view[2], b.view[2], e)],
  };
}

/** Focus track at x: [inverse depth in focus, blur amount]. */
export function focusAt(focus: { t: number; d: number; amt: number }[] | undefined, x: number): [number, number] {
  if (!focus || !focus.length) return [0.5, 0];
  const [i, e] = seg(focus.map((f) => f.t), x);
  const a = focus[i], b = focus[Math.min(i + 1, focus.length - 1)];
  return [lerp(a.d, b.d, e), lerp(a.amt, b.amt, e)];
}

/** Full camera for a frame: state plus the look-at rotation. */
export function cameraFor(keys: CamKey[], x: number, aim: [number, number] | undefined, k: number, pivot: number) {
  const st = cameraAt(keys, x);
  const za = zOf(pivot), a3: V3 = [(aim?.[0] ?? 0) * za, (aim?.[1] ?? 0) * za, za];
  const c0 = st.cam.map((c) => (1 - k) * c) as V3;
  return { ...st, rot: aimRotation(a3, st.cam, c0) };
}

/** Keep the view inside the image on each axis where it fits; centre it where it doesn't. */
export function clampViewFlat(vx: number, vy: number, vs: number, ia: number, aspect: number): V3 {
  const hx = (vs * aspect) / 2, hy = vs / 2;
  const x = hx <= ia / 2 ? clamp(vx, -ia / 2 + hx, ia / 2 - hx) : 0;
  const y = hy <= 0.5 ? clamp(vy, -0.5 + hy, 0.5 - hy) : 0;
  return [x, y, vs];
}

/** Same rule against projected bounds: the renderer applies it every frame. */
export function clampView(v: V3, b: Bounds, aspect: number): V3 {
  const [vx, vy, vs] = v, hx = (vs * aspect) / 2, hy = vs / 2;
  const fit = (c: number, h: number, lo: number, hi: number) => (2 * h <= hi - lo ? clamp(c, lo + h, hi - h) : (lo + hi) / 2);
  return [fit(vx, hx, b[0], b[1]), fit(vy, hy, b[2], b[3]), vs];
}

/** Tighten a view so a covering axis never shows past the photo's edge (letterboxed axes are left alone). */
export function fitView(v: V3, b: Bounds, aspect: number, cover: [boolean, boolean]): V3 {
  let vs = v[2];
  if (cover[0]) vs = Math.min(vs, ((b[1] - b[0]) / aspect) * 0.995);
  if (cover[1]) vs = Math.min(vs, (b[3] - b[2]) * 0.995);
  return clampView([v[0], v[1], Math.max(vs, 0.05)], b, aspect);
}

/** Points along the image edge (top, right, bottom, left; n each) with their depth in each layer. */
export interface Border { u: number[]; v: number[]; side: number[]; fig: number[]; bg: number[] }

export function border(ia: number, depthAt: ((fx: number, fy: number, fig: boolean) => number) | null, n = BORDER_N): Border {
  const u: number[] = [], v: number[] = [], side: number[] = [], fig: number[] = [], bg: number[] = [];
  for (let i = 0; i < 4 * n; i++) {
    const s = Math.floor(i / n), t = (i % n) / (n - 1);
    const fx = s === 0 || s === 2 ? t : s === 1 ? 1 : 0;
    const fy = s === 1 || s === 3 ? t : s === 2 ? 1 : 0;
    u.push((fx - 0.5) * ia); v.push(fy - 0.5); side.push(s);
    const cx = Math.min(fx, 0.999), cy = Math.min(fy, 0.999);
    fig.push(depthAt ? depthAt(cx, cy, true) : 0.5);
    bg.push(depthAt ? depthAt(cx, cy, false) : 0.5);
  }
  return { u, v, side, fig, bg };
}

/** Projected-space rectangle the photo covers for a whole move, sampled along the eased track. */
export function bounds(keys: CamKey[], k: number, aim: [number, number], dp: number, b: Border, samples = 17): Bounds {
  let lu = -Infinity, hu = Infinity, lv = -Infinity, hv = Infinity;
  for (let s = 0; s < samples; s++) {
    const x = samples > 1 ? s / (samples - 1) : 0;
    const c = cameraFor(keys, x, aim, k, dp);
    for (const d of [b.fig, b.bg])
      for (let i = 0; i < b.u.length; i++) {
        const [su, sv] = project(b.u[i], b.v[i], d[i], c.cam, c.f, c.rot, dp, c.ds);
        if (b.side[i] === 0) lv = Math.max(lv, sv);
        else if (b.side[i] === 2) hv = Math.min(hv, sv);
        else if (b.side[i] === 3) lu = Math.max(lu, su);
        else hu = Math.min(hu, su);
      }
  }
  return [lu, hu, lv, hv];
}

/** The same bounds for one instant (the renderer re-checks each frame). */
export function liveBounds(c: { cam: V3; f: number; ds: number; rot: number[] }, dp: number, b: Border): Bounds {
  let lu = -Infinity, hu = Infinity, lv = -Infinity, hv = Infinity;
  for (const d of [b.fig, b.bg])
    for (let i = 0; i < b.u.length; i++) {
      const [su, sv] = project(b.u[i], b.v[i], d[i], c.cam, c.f, c.rot, dp, c.ds);
      if (b.side[i] === 0) lv = Math.max(lv, sv);
      else if (b.side[i] === 2) hv = Math.min(hv, sv);
      else if (b.side[i] === 3) lu = Math.max(lu, su);
      else hu = Math.min(hu, su);
    }
  return [lu, hu, lv, hv];
}

/** Normalized image coordinates of a source pixel. */
export const norm = (x: number, y: number, w: number, h: number): [number, number] => [(x - w / 2) / h, (y - h / 2) / h];
