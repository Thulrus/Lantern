// Treatment layouts (spec §5.6): each treatment is a set of camera keyframes in the shared camera
// model (camera.ts). 2D moves change only `view` (ds = 0); depth moves also move the camera.
// After layout, `secure` tightens the keys so the move never reveals the photo's edge on a
// covering axis and never cuts the subject's face (spec §5.8), scaling the move down when the
// crop would get too tight.
import { clamp, lerp, type Box, area, iou } from "$lib/util/math";
import type { Prng } from "$lib/util/prng";
import { type Bounds, type V3, border, bounds, clampViewFlat, norm, zOf } from "./camera";
import type { CamKey, Style, Treatment, TreatmentId } from "./types";
import { DEPTH_TREATMENTS } from "./types";

export const MAX_ZOOM = 0.72;       // a move may crop the view to this fraction of its framing
const COVER_MARGIN = 0.92;          // covering views stay this far inside the image
const NEAR_COVER = 1.1;             // views within this much of filling the screen fill it
const FACE_PAD = 1.35;              // headroom around faces when framing them
const FACE_MAX = 0.6;               // a face never fills more than this share of the frame height
const SEP_FULL = 0.18, Q_MIN = 0.35, Q_NO_SUBJECT = 0.4;
const PUSH = 0.1, DOLLY = 0.12, ARC = 0.24, CRANE = 0.15, INFLATE = 0.14;
const SWEEP_SPEED = 0.5;          // peak travel of sweeps and tours (panSpeed metric), screen heights per second

export interface DepthProbe { sep: number; pivot: number; quality: number; depthAt?: (fx: number, fy: number, fig: boolean) => number }

export interface MotionInput {
  w: number; h: number; aspect: number;
  faces: Box[];                   // confident faces, source px, largest first
  pois: Box[];                    // points of interest: faces, then salient peaks
  depth?: DepthProbe;
  dur: number;
  panSpeed: number;               // screen heights per second
  resolutionScale: number;        // source height / output height (zoom limit, spec §5.8)
}

const key = (t: number, view: V3, cam: V3 = [0, 0, 0], f = 1, ds = 0): CamKey => ({ t, view, cam, f, ds });

/** The subject to protect: the union of the faces, grown; else the strongest point of interest. */
export function subjectBox(inp: MotionInput): Box | null {
  if (inp.faces.length) {
    let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of inp.faces) b = [Math.min(b[0], f[0]), Math.min(b[1], f[1]), Math.max(b[2], f[2]), Math.max(b[3], f[3])];
    return b;
  }
  return inp.pois[0] ?? null;
}

/** Frame the subject as large as the screen allows, between filling the screen and showing the
 *  whole photo, with margin for the move (Flicker's base view). */
export function baseView(inp: MotionInput, subject: Box | null): V3 {
  const ia = inp.w / inp.h, aspect = inp.aspect;
  const cover = Math.min(1, ia / aspect), contain = Math.max(1, ia / aspect);
  if (!subject) {
    const vs = cover / contain > 0.66 ? cover * COVER_MARGIN : contain;
    return clampViewFlat(0, 0, vs, ia, aspect);
  }
  const [u0, v0] = norm(subject[0], subject[1], inp.w, inp.h), [u1, v1] = norm(subject[2], subject[3], inp.w, inp.h);
  let vs = Math.max(v1 - v0, (u1 - u0) / aspect) * FACE_PAD * 2.2;
  vs = clamp(vs, cover * COVER_MARGIN, contain);
  return clampViewFlat((u0 + u1) / 2, (v0 + v1) / 2, vs, ia, aspect);
}

/** Zoomed view on a box: for tour stops and sweep dwell points. */
function boxView(inp: MotionInput, b: Box, base: V3, lo = 0.35, hi = 0.8, pad = 2.6): V3 {
  const [u0, v0] = norm(b[0], b[1], inp.w, inp.h), [u1, v1] = norm(b[2], b[3], inp.w, inp.h);
  const vs = clamp(Math.max(v1 - v0, (u1 - u0) / inp.aspect) * pad, base[2] * lo, base[2] * hi);
  return clampViewFlat((u0 + u1) / 2, (v0 + v1) / 2, vs, inp.w / inp.h, inp.aspect);
}

/** The smallest view height that keeps a face inside with headroom and under FACE_MAX. */
function minViewForFace(inp: MotionInput, f: Box): number {
  const fh = (f[3] - f[1]) / inp.h, fw = (f[2] - f[0]) / inp.h;
  return Math.max(fh / FACE_MAX, fh * FACE_PAD, (fw * FACE_PAD) / inp.aspect);
}

/** Focal point for pushes: the main face, else the strongest point of interest, else the centre. */
function focalPoint(inp: MotionInput): [number, number] | null {
  const b = inp.faces[0] ?? inp.pois[0];
  return b ? norm((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, inp.w, inp.h) : null;
}

/** Suitability of each treatment for this picture (0..1), from the analysis features. */
export function suitability(id: TreatmentId, inp: MotionInput, flags: { screenshot?: boolean; short?: boolean }): number {
  const ia = inp.w / inp.h, rel = ia / inp.aspect;
  const n = inp.faces.length, sep = inp.depth?.sep ?? 0, dq = inp.depth?.quality ?? 0;
  const hasDepth = !!inp.depth && dq > 0.3;
  if (DEPTH_TREATMENTS.has(id) && !hasDepth) return 0;
  switch (id) {
    case "hold": return flags.screenshot ? 1 : flags.short ? 0.8 : 0.25;
    case "push": return flags.screenshot ? 0 : n === 1 ? 0.95 : n === 0 && inp.pois.length ? 0.7 : 0.45;
    case "pull": return flags.screenshot ? 0 : n === 1 ? 0.6 : 0.4;
    case "pan": return flags.screenshot ? 0.1 : rel > 1.35 || rel < 0.75 ? 0.95 : 0.3;
    case "sweep": return n >= 3 ? 0.95 : n === 2 ? 0.5 : 0;
    case "tour": return inp.pois.length >= 2 && inp.resolutionScale >= 1.4 && !flags.screenshot ? 0.8 : 0;
    case "depthPush": return clamp(sep / SEP_FULL, 0.2, 1) * (n <= 2 ? 1 : 0.6);
    case "arc": return sep >= 0.1 ? clamp(sep / SEP_FULL, 0.3, 1) : 0;
    case "crane": return sep >= 0.06 ? 0.6 : 0;
    case "inflate": return sep >= 0.1 ? 0.5 : 0;
    case "dollyZoom": return sep >= 0.15 && n === 1 ? 0.4 : 0;
    case "focusPull": return n >= 1 && sep >= 0.08 ? 0.7 : 0;
  }
}

/** Lay out one treatment at amplitude `amount` (1 = full). Direction is -1 or 1. */
export function layout(id: TreatmentId, inp: MotionInput, rng: Prng, amount: number, direction: number): Treatment {
  const ia = inp.w / inp.h, aspect = inp.aspect;
  const subject = subjectBox(inp);
  const base = baseView(inp, subject);
  const fp = focalPoint(inp);
  const q = inp.depth ? (inp.depth.sep > 0 ? clamp(inp.depth.sep / SEP_FULL, Q_MIN, 1) : Q_NO_SUBJECT) : Q_NO_SUBJECT;
  const dp = inp.depth?.pivot ?? 0.5;
  const g = amount;
  const side = direction >= 0 ? 1 : -1, up = rng.next() < 0.5 ? -1 : 1;
  const aim: [number, number] = subject ? norm((subject[0] + subject[2]) / 2, subject[1] + 0.4 * (subject[3] - subject[1]), inp.w, inp.h) : [0, 0];
  const t: Treatment = { id, amount, direction, keys: [], aim, k: 0, pivot: dp };
  const out = (keys: CamKey[], k = 0) => { t.keys = keys; t.k = k; return t; };

  switch (id) {
    case "hold": {
      const near = clampViewFlat(base[0], base[1], base[2] * (1 - 0.02 * g), ia, aspect);
      return out([key(0, base), key(1, near)]);
    }
    case "push":
    case "pull": {
      const zoom = 1 - 0.22 * g;
      const tx = fp ? lerp(base[0], fp[0], 0.55) : base[0], ty = fp ? lerp(base[1], fp[1], 0.55) : base[1];
      let vs = base[2] * zoom;
      if (inp.faces[0]) vs = Math.max(vs, minViewForFace(inp, inp.faces[0]));
      const near = clampViewFlat(tx, ty, vs, ia, aspect);
      const keys = [key(0, base), key(1, near)];
      return out(id === "pull" ? [{ ...keys[1], t: 0 }, { ...keys[0], t: 1 }] : keys);
    }
    case "pan": {
      // Travel along the long axis at the covering scale, as far as the pan speed allows.
      const horizontal = ia / aspect >= 1;
      const cover = Math.min(1, ia / aspect);
      const vs = cover * (horizontal ? 1 : COVER_MARGIN);
      const span = horizontal ? ia - vs * aspect : 1 - vs; // free travel in view units
      const maxTravel = inp.panSpeed * inp.dur * vs;
      const travel = Math.min(span, maxTravel) * g;
      const a = horizontal ? [-(travel / 2) * side, base[1]] : [base[0], -(travel / 2) * side];
      const b = horizontal ? [(travel / 2) * side, base[1]] : [base[0], (travel / 2) * side];
      return out([key(0, clampViewFlat(a[0], a[1], vs, ia, aspect)), key(1, clampViewFlat(b[0], b[1], vs, ia, aspect))]);
    }
    case "sweep": {
      // Along the row of faces, dwelling near each when there is time, ending wide on everyone.
      // The travel speed is capped: the view widens until the sweep fits the slide's duration,
      // and a slide too short for any sweep gets a gentle push instead.
      const faces = [...inp.faces].sort((p, q2) => (p[0] + p[2]) / 2 - (q2[0] + q2[2]) / 2);
      if (side < 0) faces.reverse();
      const n = faces.length;
      const centres = faces.map((f) => norm((f[0] + f[2]) / 2, (f[1] + f[3]) / 2, inp.w, inp.h));
      const rowH = Math.max(...faces.map((f) => f[3] - f[1])) / inp.h;
      const vsFace = clamp(Math.max(rowH * 3.2, minViewForFace(inp, faces[0]) * 1.1), base[2] * 0.4, base[2] * 0.85);
      let travel = 0;
      for (let i = 1; i < n; i++) travel += Math.hypot(centres[i][0] - centres[i - 1][0], centres[i][1] - centres[i - 1][1]);
      const span = 0.78; // share of the move spent travelling; the rest widens to the group
      if (n < 2 || inp.dur < 2) return layout("push", inp, rng, amount * 0.6, direction);
      const segSec = (inp.dur * span) / (n - 1);
      const dwellSec = segSec >= 1.4 ? 0.3 : 0, dwell = dwellSec / inp.dur;
      const travelSec = Math.max(inp.dur * span - n * dwellSec, 0.1);
      // panSpeed() reports the eased peak (1.5× the mean), so size the view for that.
      let vs = Math.max(vsFace, (1.5 * travel) / (SWEEP_SPEED * travelSec));
      let keys: CamKey[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        if (vs >= base[2] * 0.95) return layout("push", inp, rng, amount * 0.6, direction);
        keys = [];
        for (let i = 0; i < n; i++) {
          const v = clampViewFlat(centres[i][0], centres[i][1] - 0.02 * vs, vs, ia, aspect);
          const t0 = (i / (n - 1)) * span;
          if (dwell && i > 0) keys.push(key(t0 - dwell / 2, v));
          keys.push(key(i === 0 ? 0 : dwell && i < n - 1 ? t0 + dwell / 2 : t0, v));
          if (dwell && i === 0) keys.push(key(dwell / 2, v));
        }
        keys.push(key(1, base));
        keys = dedupeKeys(keys);
        if (panSpeed(keys, inp.dur) <= SWEEP_SPEED) break;
        vs *= 1.12;
      }
      return out(keys);
    }
    case "tour": {
      // A slow path through the points of interest, then the whole frame. Stops are dropped
      // while the path would move too fast for the slide's duration.
      if (inp.dur < 2.5 || inp.pois.length < 2) return layout("push", inp, rng, amount, direction);
      let stops = inp.pois.slice(0, 2 + rng.int(Math.min(3, inp.pois.length) - 1));
      stops.sort((p, q2) => (p[0] + p[2]) / 2 - (q2[0] + q2[2]) / 2);
      if (side < 0) stops.reverse();
      for (;;) {
        const n = stops.length + 1;
        const keys: CamKey[] = [key(0, base)];
        stops.forEach((b, i) => keys.push(key(((i + 1) / n) * 0.85, boxView(inp, b, base))));
        keys.push(key(1, base));
        if (panSpeed(keys, inp.dur) <= SWEEP_SPEED || stops.length <= 1) {
          if (panSpeed(keys, inp.dur) > SWEEP_SPEED) return layout("push", inp, rng, amount, direction);
          t.stops = stops;
          return out(keys);
        }
        stops = stops.slice(0, -1);
      }
    }
    case "depthPush": {
      const cz = DOLLY * q * g;
      const v = clampViewFlat(base[0], base[1], base[2] * 0.94, ia, aspect);
      const zp = zOf(dp);
      return out([key(0, v, [0, 0, 0], 1, 1), key(1, v, [0, 0, cz], (zp - cz) / zp, 1)]);
    }
    case "arc": {
      const a = ARC * q * g;
      const v1 = clampViewFlat(base[0], base[1], base[2] * 0.96, ia, aspect);
      return out([key(0, base, [-side * a, -0.15 * up * a, 0], 1, 1), key(1, v1, [side * a, 0.15 * up * a, 0.05 * q * g], 1, 1)], 1);
    }
    case "crane": {
      const b = CRANE * q * g;
      return out([key(0, base, [-0.3 * side * b, -up * b, 0], 1, 1), key(1, base, [0.3 * side * b, up * b, 0.04 * q * g], 1, 1)], 1);
    }
    case "inflate": {
      const a = INFLATE * q * g;
      const v1 = clampViewFlat(base[0], base[1], base[2] * 0.96, ia, aspect);
      return out([key(0, base, [0, 0, 0], 1, 0), key(1, v1, [side * a, -0.2 * up * a, 0.05 * q * g], 1, 1.15)], 1);
    }
    case "dollyZoom": {
      // Vertigo: the camera pushes in while the focal length widens, so the subject holds its size.
      const cz = PUSH * 1.6 * q * g, zp = zOf(dp);
      return out([key(0, base, [0, 0, 0], 1, 1), key(1, base, [0, 0, cz], (zp - cz) / zp, 1)], 1);
    }
    case "focusPull": {
      const near = clampViewFlat(base[0], base[1], base[2] * 0.95, ia, aspect);
      t.focus = [{ t: 0, d: dp - 0.3, amt: 6 * q }, { t: 0.3, d: dp - 0.3, amt: 6 * q }, { t: 0.7, d: dp, amt: 4 * q }, { t: 1, d: dp, amt: 4 * q }];
      return out([key(0, base, [0, 0, 0], 1, 1), key(1, near, [0, 0, 0.02 * q * g], 1, 1)]);
    }
  }
}

function dedupeKeys(keys: CamKey[]): CamKey[] {
  const out: CamKey[] = [];
  for (const k of keys) if (!out.length || k.t > out[out.length - 1].t + 1e-4) out.push(k);
  return out;
}

export interface Secured { treatment: Treatment; bounds: Bounds; cover: [boolean, boolean]; amount: number; repaired: string[] }

/** Edge and face safety (spec §5.8): project the photo's border along the whole track, tighten
 *  keys to fit, keep the subject's faces in frame, and scale the move down when the crop
 *  would fall below MAX_ZOOM of its framing. Resolution: never zoom past 1.25x upscaling. */
export function secure(id: TreatmentId, inp: MotionInput, rng: Prng, amount: number, direction: number): Secured {
  const ia = inp.w / inp.h, aspect = inp.aspect;
  const b = border(ia, inp.depth?.depthAt ?? null);
  const repaired: string[] = [];
  let g = amount;
  const minVs = 1 / (inp.resolutionScale * 1.25); // view height (image heights) below which we upscale > 1.25x
  let result: Secured | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const fork = rng.fork(`${id}:${attempt}`);
    const t = layout(id, inp, fork, g, direction);
    const planned = t.keys.map((k) => k.view[2]);
    const bb = bounds(t.keys, t.k ?? 0, t.aim ?? [0, 0], t.pivot ?? 0.5, b);
    const cover: [boolean, boolean] = [t.keys.some((k) => k.view[2] * aspect <= ia * NEAR_COVER), t.keys.some((k) => k.view[2] <= NEAR_COVER)];
    for (const k of t.keys) {
      let [vx, vy, vs] = k.view;
      if (vs < minVs) { vs = minVs; repaired.push("resolution"); }
      // Face safety: the subject's faces stay inside (sweeps may let faces pass; their ends show all).
      // Sweeps let faces pass through the frame and end wide on everyone; other moves keep the main face in.
      const guard = t.id === "sweep" ? (k === t.keys[t.keys.length - 1] ? inp.faces : []) : inp.faces.slice(0, 1);
      for (const f of guard) {
        const [u0, v0] = norm(f[0], f[1], inp.w, inp.h), [u1, v1] = norm(f[2], f[3], inp.w, inp.h);
        const fh = v1 - v0, fw = u1 - u0;
        const need = Math.max(fh * FACE_PAD, (fw * FACE_PAD) / aspect, fh / FACE_MAX);
        if (vs < need) { vs = need; repaired.push("face"); }
        const hx = (vs * aspect) / 2, hy = vs / 2, pad = 0.08 * vs;
        vx = clamp(vx, u1 + pad - hx, u0 - pad + hx);
        vy = clamp(vy, v1 + pad - hy, v0 - pad + hy);
      }
      k.view = inside([vx, vy, vs], bb, aspect, cover);
    }
    const ratio = Math.min(...t.keys.map((k, i) => k.view[2] / Math.max(planned[i], 1e-6)));
    result = { treatment: t, bounds: bb, cover, amount: g, repaired };
    if (ratio >= MAX_ZOOM || g < 0.2) break;
    g *= 0.65;
    repaired.push("scaled");
  }
  return result!;
}

/** Tighten a view so the move never reveals the photo's edge on a covering axis. */
export function inside(view: V3, bb: Bounds, aspect: number, cover: [boolean, boolean]): V3 {
  const [vx, vy, vs] = view;
  const lim = [vs];
  if (cover[0]) lim.push(((bb[1] - bb[0]) / aspect) * 0.995);
  if (cover[1]) lim.push((bb[3] - bb[2]) * 0.995);
  const s = Math.max(Math.min(...lim), 0.05);
  const hx = (s * aspect) / 2, hy = s / 2;
  const fit = (c: number, h: number, lo: number, hi: number) => (2 * h <= hi - lo ? clamp(c, lo + h, hi - h) : (lo + hi) / 2);
  return [fit(vx, hx, bb[0], bb[1]), fit(vy, hy, bb[2], bb[3]), s];
}

/** Points of interest: faces first, then salient peaks that don't overlap an earlier one. */
export function pointsOfInterest(faces: Box[], peaks: Box[]): Box[] {
  const out: Box[] = [...faces];
  for (const p of peaks) if (out.every((o) => iou(p, o) < 0.3) && area(p) > 0) out.push(p);
  return out.slice(0, 4);
}

/** Max pan speed check (screen heights per second) over a track. */
export function panSpeed(keys: CamKey[], dur: number): number {
  let worst = 0;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i], dt = Math.max((b.t - a.t) * dur, 1e-3);
    const d = Math.hypot(b.view[0] - a.view[0], b.view[1] - a.view[1]) / ((a.view[2] + b.view[2]) / 2);
    worst = Math.max(worst, (d / dt) * 1.5); // smoothstep peaks at 1.5x the mean speed
  }
  return worst;
}

export const styleWeight = (style: Style, id: TreatmentId) => style.treatmentWeights[id] ?? 0;
