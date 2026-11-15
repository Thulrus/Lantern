// Geometry for the framing editor (spec §11.2): which keys of a move the user can drag, the
// stage they are drawn on, and the limits a dragged frame obeys. Pure, so it is unit-tested.
import { clamp } from "$lib/util/math";
import { type V3, clampViewFlat } from "./camera";
import type { CamKey } from "./types";

/** One draggable frame: a run of consecutive keys with the same view (a sweep's dwell keeps two
 *  equal keys; moving one without the other made the camera jump back to the old framing). */
export interface FrameGroup { keys: number[]; t: number; label: string }

const same = (a: V3, b: V3) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;

export function frameGroups(keys: CamKey[]): FrameGroup[] {
  const groups: FrameGroup[] = [];
  keys.forEach((k, i) => {
    const last = groups[groups.length - 1];
    // The last key is always its own frame: a move that starts and ends on the same view still has a start and an end.
    if (last && i < keys.length - 1 && same(keys[last.keys[last.keys.length - 1]].view, k.view)) last.keys.push(i);
    else groups.push({ keys: [i], t: k.t, label: "" });
  });
  groups.forEach((g, i) => (g.label = i === 0 ? "Start" : i === groups.length - 1 ? "End" : `Stop ${i}`));
  if (groups.length === 1) groups[0].label = "Frame";
  return groups;
}

/** The widest view allowed: the whole photo inside the output frame (letterboxed on one axis). */
export const containVs = (ia: number, aspect: number) => Math.max(1, ia / aspect);

/** The editor's stage in image heights, centred like the camera's coordinates: the whole-photo
 *  view, so every allowed frame lies inside it (frames used to run off the editor's edge). */
export function stageSize(ia: number, aspect: number): [number, number] {
  return [Math.max(ia, aspect), containVs(ia, aspect)];
}

/** Keep a dragged frame between `minVs` and the whole photo, and inside the photo where it fits. */
export function fitFrame(v: V3, ia: number, aspect: number, minVs = 0.1): V3 {
  return clampViewFlat(v[0], v[1], clamp(v[2], minVs, containVs(ia, aspect)), ia, aspect);
}

/** Resize from a corner while the opposite corner stays put. `corner` is [sx, sy] in {-1, 1}
 *  (the dragged corner's side); `p` is the pointer in camera coordinates. */
export function resizeFrom(v0: V3, corner: [number, number], p: [number, number], ia: number, aspect: number, minVs = 0.1): V3 {
  const [sx, sy] = corner;
  const ax = v0[0] - (sx * v0[2] * aspect) / 2, ay = v0[1] - (sy * v0[2]) / 2; // the fixed corner
  const vs = clamp(Math.max((sx * (p[0] - ax)) / aspect, sy * (p[1] - ay)), minVs, containVs(ia, aspect));
  return fitFrame([ax + (sx * vs * aspect) / 2, ay + (sy * vs) / 2, vs], ia, aspect, minVs);
}

/** A track with stops reduced to a straight move from its first to its last key. */
export function straighten(keys: CamKey[]): CamKey[] {
  if (keys.length <= 2) return keys.map((k) => ({ ...k }));
  return [{ ...keys[0], t: 0 }, { ...keys[keys.length - 1], t: 1 }];
}
