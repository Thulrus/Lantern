// compile(project, analysis, music) → Timeline (spec §8.3): everything the renderer needs,
// resolved to plain numbers in show time. The renderer never reads the Project.
import { border, bounds } from "./camera";
import { musicGrid, songEvents } from "./music";
import { resolveStyle } from "./styles";
import { depthProbe } from "$lib/analysis/depthmath";
import { ASPECTS, type AudioEvent, type CaptionEvent, type MediaAnalysis, type MusicAnalysis, type Project, type RenderSlide, type Slide, type Timeline } from "./types";

const FILL_INDEX = { cover: 0, pair: 1, extend: 2, tilt: 3, blur: 4 } as const;

export function compile(project: Project, analysis: Map<string, MediaAnalysis>, music: Map<string, MusicAnalysis>): Timeline {
  const aspect = ASPECTS[project.output.aspect];
  const h = project.output.height, w = Math.round((h * aspect) / 2) * 2;
  const style = resolveStyle(project.styleId, project.styleOverrides);
  const slides = project.slides;
  const layers: RenderSlide[] = [];
  const captions: CaptionEvent[] = [];
  const grid = musicGrid(project, music);
  const showDur = slides.length ? slides[slides.length - 1].start + slides[slides.length - 1].dur : 0;
  const accents = style.beatSync === "cuts+accents" && grid ? grid.beats.filter((_, i) => grid.downbeats.has(i)) : [];

  slides.forEach((s, i) => {
    const next = slides[i + 1];
    const t0 = s.start;
    const t1 = s.start + s.dur + (next ? overlapOf(next) : 0);
    const rs = renderSlide(s, analysis, aspect, t0, t1, style);
    if (next && next.transitionIn.dur > 0 && next.transitionIn.type !== "cut") {
      // Nothing: the next slide's `enter` window carries the transition; this layer just outlasts it.
    }
    if (s.transitionIn.dur > 0 && s.transitionIn.type !== "cut") rs.enter = { type: s.transitionIn.type, t0: s.start - overlapOf(s), t1: s.start - overlapOf(s) + s.transitionIn.dur };
    if (s.transitionIn.type === "cut") rs.enter = { type: "cut", t0: s.start, t1: s.start };
    if (accents.length) rs.accents = accents.filter((b) => b >= t0 && b <= t1);
    layers.push(rs);
    if (s.caption?.text && !rs.title) {
      const from = s.start + (s.caption.from ?? 0), to = s.caption.to !== undefined ? s.start + s.caption.to : s.start + s.dur;
      captions.push({ t0: from, t1: Math.min(to, s.start + s.dur), text: s.caption.text, position: s.caption.position, style: s.caption.style, slideId: s.id });
    }
  });
  // Layers start at the enter window so the renderer draws them during their arrival.
  for (const l of layers) if (l.enter && l.enter.type !== "cut") l.t0 = Math.min(l.t0, l.enter.t0);

  const ducks: [number, number, number][] = [];
  for (const s of slides) if (s.kind === "video" && s.clip && s.clip.gain > 0) ducks.push([s.start, s.start + s.dur, s.clip.gain >= 1 ? -12 : -6]);
  const audio: AudioEvent[] = grid ? songEvents(grid, showDur, ducks) : [];
  for (const s of slides)
    if (s.kind === "video" && s.clip && s.clip.gain > 0)
      audio.push({ src: s.items[0], at: s.start, in: s.clip.in, out: s.clip.out, gain: { points: [[s.start, 0], [s.start + 0.15, s.clip.gain], [s.start + s.dur - 0.15, s.clip.gain], [s.start + s.dur, 0]] }, kind: "clip" });

  return { v: 1, dur: showDur, fps: project.output.fps, size: [w, h], aspect, layers, audio, captions, beats: grid?.beats ?? [] };
}

/** How far a slide's arrival overlaps the previous slide: the whole transition for fades and
 *  wipes, which play while the previous slide still runs. */
const overlapOf = (s: Slide) => (s.transitionIn.type === "cut" ? 0 : s.transitionIn.dur);

function renderSlide(s: Slide, analysis: Map<string, MediaAnalysis>, aspect: number, t0: number, t1: number, style: ReturnType<typeof resolveStyle>): RenderSlide {
  const base: RenderSlide = { id: s.id, t0, t1, w: 16, h: 9, assets: {}, keys: s.treatment.keys, focus: s.treatment.focus, aim: s.treatment.aim, k: s.treatment.k ?? 0, pivot: s.treatment.pivot ?? 0.5, fill: FILL_INDEX[s.fill] };
  if (s.kind === "title") {
    base.title = { text: s.caption?.text ?? "", style: "title", animation: style.titles.animation };
    base.keys = [{ t: 0, view: [0, 0, 1], cam: [0, 0, 0], f: 1, ds: 0 }];
    return base;
  }
  if (s.kind === "pair" && s.items.length === 2) {
    const gutter = 0.004;
    const cells = s.items.map((hsh, i) => {
      const m = analysis.get(hsh);
      const cell = renderSlide({ ...s, kind: "photo", items: [hsh], treatment: pairTreatment(s, i, m, aspect / 2) }, analysis, aspect / 2, t0, t1, style);
      return { rect: [i === 0 ? 0 : 0.5 + gutter / 2, 0, 0.5 - gutter / 2, 1] as [number, number, number, number], slide: cell };
    });
    base.cells = cells;
    return base;
  }
  const m = analysis.get(s.items[0]);
  if (!m) return base;
  base.w = m.info.w; base.h = m.info.h;
  base.assets.image = { hash: m.info.hash, kind: "image" };
  if (m.info.kind === "video") { base.assets.video = { hash: m.info.hash, kind: "video" }; base.clip = s.clip ? { in: s.clip.in, speed: s.clip.speed } : { in: 0, speed: 1 }; }
  if (m.depth) base.assets.maps = { hash: m.info.hash, kind: "maps" };
  const ia = m.info.w / m.info.h;
  const bb = bounds(base.keys, base.k ?? 0, base.aim ?? [0, 0], base.pivot ?? 0.5, border(ia, m.depth ? depthProbe(m.depth) : null));
  base.bounds = bb;
  base.cover = [base.keys.some((k) => k.view[2] * aspect <= ia * 1.1), base.keys.some((k) => k.view[2] <= 1.1)];
  return base;
}

/** Each half of a pair gets its own gentle move, offset in phase (spec §5.3). */
function pairTreatment(s: Slide, i: number, m: MediaAnalysis | undefined, cellAspect: number): Slide["treatment"] {
  if (!m) return s.treatment;
  const ia = m.info.w / m.info.h;
  const cover = Math.min(1, ia / cellAspect);
  const vs0 = cover * 0.98, vs1 = cover * 0.9;
  const a = i === 0 ? vs0 : vs1, b = i === 0 ? vs1 : vs0;
  const face = (m.faces ?? [])[0];
  const cy = face ? ((face.box[1] + face.box[3]) / 2 - m.info.h / 2) / m.info.h : 0;
  return { id: "push", amount: 0.5, keys: [{ t: 0, view: [0, clampY(cy * 0.5, a), a], cam: [0, 0, 0], f: 1, ds: 0 }, { t: 1, view: [0, clampY(cy * 0.6, b), b], cam: [0, 0, 0], f: 1, ds: 0 }], k: 0, pivot: 0.5 };
}
const clampY = (y: number, vs: number) => Math.max(-0.5 + vs / 2, Math.min(0.5 - vs / 2, y));
