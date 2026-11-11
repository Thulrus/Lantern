// The automatic director (spec §5): plan(project, analysis, music, options) → slides. Pure and
// deterministic: every random choice comes from the project's seed. Re-planning rewrites only
// unlocked fields of existing slides (spec §8.2).
import { clamp, type Box } from "$lib/util/math";
import { Prng, hash32 } from "$lib/util/prng";
import { curate } from "./curate";
import { desiredDuration, treatmentMinimum } from "./durations";
import { fitToBeats, snapToBeats } from "./fit";
import { group, type GroupedItem } from "./group";
import { layout, pointsOfInterest, secure, suitability, type MotionInput } from "./motion";
import { musicGrid, type MusicGrid } from "./music";
import { order } from "./order";
import { resolveStyle } from "./styles";
import { chooseTransition } from "./transitions";
import { ASPECTS, DEPTH_TREATMENTS, TREATMENTS, TREATMENT_NAMES, type LookId, type MediaAnalysis, type MusicAnalysis, type Project, type Slide, type Style, type Treatment, type TreatmentId } from "./types";

export interface PlanResult {
  slides: Slide[];
  warnings: string[];
  mismatch?: { need: number; have: number };
  suggestedOut: Record<string, string>;
  alternates: Record<string, string[]>;
  duration: number;
}

export interface PlanOptions { seed?: number; includeFlagged?: boolean; keepLocks?: boolean }

const ACCENTS = new Set<TreatmentId>(["inflate", "dollyZoom"]);

export function plan(project: Project, analysis: Map<string, MediaAnalysis>, music: Map<string, MusicAnalysis>, opts: PlanOptions = {}): PlanResult {
  const style = resolveStyle(project.styleId, project.styleOverrides);
  const seed = opts.seed ?? project.seed;
  const rng = new Prng(seed);
  const warnings: string[] = [];
  const aspect = ASPECTS[project.output.aspect];
  const prior = new Map(project.slides.map((s) => [s.id, s]));
  const keepLocks = opts.keepLocks ?? true;

  // Pass 1: curate.
  const excluded = new Set(project.excluded), starred = new Set(project.starred);
  const items = project.media.filter((h) => !excluded.has(h)).map((h) => analysis.get(h)).filter((m): m is MediaAnalysis => !!m);
  const cur = curate(items, { includeFlagged: opts.includeFlagged, flipbooks: false });
  const kept = cur.kept.filter((h) => !(h in cur.suggestedOut) || starred.has(h));
  for (const h of project.starred) if (cur.suggestedOut[h]) delete cur.suggestedOut[h];

  // Pass 2: order. Manual order follows the existing slide order where it exists.
  let ordered;
  if (project.order === "manual" && project.slides.length) {
    const pos = new Map<string, number>();
    project.slides.forEach((s, i) => s.items.forEach((h) => pos.set(h, i)));
    const seq = [...kept].sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
    ordered = order("manual", seq, analysis, rng, project.featuredPerson);
  } else ordered = order(project.order, kept, analysis, rng, project.featuredPerson);

  // Featured person: open and close on them (spec §5.9).
  if (project.featuredPerson) {
    const has = (h: string) => analysis.get(h)?.personId === project.featuredPerson;
    const first = ordered.hashes.find(has);
    if (first) {
      const i = ordered.hashes.indexOf(first);
      ordered.hashes.splice(i, 1); ordered.chapter.splice(i, 1);
      ordered.hashes.unshift(first); ordered.chapter.unshift(ordered.chapter[0] ?? 0);
    }
  }

  // Pass 3: group.
  const grouped = group(ordered.hashes, ordered.chapter, analysis, project.output.aspect, cur.flipbooks, project.order !== "manual");
  const units: GroupedItem[] = [];
  const chapterStarts = new Set<number>();
  if (project.titles.intro) units.push({ kind: "photo", items: [], chapter: -1 });
  let lastCh = -1;
  for (const g of grouped) {
    if (project.titles.chapters && g.chapter !== lastCh && lastCh !== -1) chapterStarts.add(units.length);
    lastCh = g.chapter;
    units.push(g);
  }
  if (project.titles.end) units.push({ kind: "photo", items: [], chapter: -2 });
  if (!units.length) return { slides: [], warnings: ["No photos to show."], suggestedOut: cur.suggestedOut, alternates: cur.alternates, duration: 0 };

  // Music grid.
  const grid = musicGrid(project, music);
  const hasMusic = !!grid && project.fit !== "free" ? true : !!grid;

  // Pass 6a: choose a treatment id per unit (needed for the duration minimum), with variety.
  const slideIds = units.map((u, i) => slideId(u, i));
  const chosen: { id: TreatmentId; alternates: TreatmentId[]; reasons: string[]; dir: number }[] = [];
  const recent: TreatmentId[] = [];
  let depthUsed = 0, lastDir = 1;
  const maxDepth = Math.floor(style.depthShare * units.length);
  units.forEach((u, i) => {
    const srng = rng.fork(slideIds[i]);
    const old = prior.get(slideIds[i]);
    if (u.items.length === 0) { chosen.push({ id: "hold", alternates: [], reasons: ["title card"], dir: 1 }); return; }
    if (keepLocks && old?.locks.treatment) { chosen.push({ id: old.treatment.id, alternates: old.auto.alternates.map((a) => a.id), reasons: ["locked"], dir: old.treatment.direction ?? 1 }); return; }
    const m = analysis.get(u.items[0])!;
    const inp = motionInput(m, aspect, project.output.height, style, 4);
    const flags = { screenshot: !!m.basics?.flags.includes("screenshot") || (m.tags?.screenshot ?? 0) > 0.5, short: false };
    const scored = TREATMENTS.map((id) => {
      let s = suitability(id, inp, flags) * (style.treatmentWeights[id] ?? 0);
      if (u.kind === "video") s = id === "hold" ? 1 : id === "push" ? 0.5 : 0;
      if (u.kind === "pair") s = id === "sweep" || id === "tour" ? 0 : s;
      if (recent.length >= 2 && recent[recent.length - 1] === id && recent[recent.length - 2] === id) s = 0; // at most twice in a row
      else if (recent[recent.length - 1] === id) s *= 0.5;
      if (DEPTH_TREATMENTS.has(id) && depthUsed >= maxDepth) s = 0;
      if (ACCENTS.has(id) && i > 0 && !chapterStarts.has(i)) s *= 0.2;
      return { id, s: s * (0.7 + 0.3 * srng.next()) };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const pick = scored.length ? scored[srng.weighted(scored.map((x) => x.s))] : { id: "push" as TreatmentId, s: 1 };
    const id = scored.length ? pick.id : "push";
    const alternates = scored.filter((x) => x.id !== id).slice(0, 3).map((x) => x.id);
    if (DEPTH_TREATMENTS.has(id)) depthUsed++;
    recent.push(id);
    // Alternate the direction of consecutive pans and orbits.
    const dir = id === "pan" || id === "sweep" || id === "arc" ? (lastDir = -lastDir) : srng.next() < 0.5 ? -1 : 1;
    const why = explain(id, inp, m);
    chosen.push({ id, alternates, reasons: why, dir });
  });

  // Pass 4: desired durations.
  const desired: number[] = [], durReasons: string[][] = [];
  units.forEach((u, i) => {
    const old = prior.get(slideIds[i]);
    if (u.items.length === 0) { const text = u.chapter === -1 ? project.titles.intro! : project.titles.end!; desired.push(titleDur(text)); durReasons.push(["title"]); return; }
    const m = analysis.get(u.items[0])!;
    const faces = (m.faces ?? []).filter((f) => f.score >= 0.5).length;
    const screenshot = !!m.basics?.flags.includes("screenshot") || (m.tags?.screenshot ?? 0) > 0.5;
    const tMin = treatmentMinimum(chosen[i].id, faces, 3);
    const energyGuess = grid ? grid.sectionAt(clamp(estimateStart(desired, grid.total, units.length, i), 0, grid.total - 0.01))?.energy : undefined;
    const video = u.kind === "video" && m.info.duration ? clipLength(m, style) : undefined;
    const d = desiredDuration(style, { faces, complexity: m.basics?.edgeDensity ?? 0.3, starred: starred.has(u.items[0]), screenshot, pair: u.kind === "pair", video, energy: energyGuess, treatmentMin: tMin });
    if (keepLocks && old?.locks.dur) { desired.push(old.dur); durReasons.push(["duration locked"]); return; }
    desired.push(d.dur); durReasons.push(d.reasons);
  });

  // Pass 5: fit to music.
  let starts: number[], durs: number[];
  let mismatch: PlanResult["mismatch"];
  const major = units.map((u, i) => i === 0 || chapterStarts.has(i) || u.items.length === 0);
  const locked = units.map((u, i) => (keepLocks && prior.get(slideIds[i])?.locks.dur ? prior.get(slideIds[i])!.dur : undefined));
  if (grid && project.fit === "show-to-music" && grid.beats.length > 2) {
    const slides = units.map((_, i) => ({ desired: desired[i], locked: locked[i], major: major[i], min: style.pace.min * 0.6 }));
    let r = fitToBeats(slides, { beats: grid.beats, downbeats: grid.downbeats, sections: grid.sections });
    if (!r.ok) {
      mismatch = { need: r.need, have: r.have };
      warnings.push(`The photos need about ${fmt(r.need)}; the music is ${fmt(r.have)}.`);
      if (!r.starts.length) {
        // No beat solution at all: scale durations proportionally and snap to beats.
        const k = r.have / Math.max(r.need, 1e-6);
        const scaled = desired.map((d, i) => locked[i] ?? d * k);
        r = { ...snapToBeats(scaled, grid.beats, true), cost: 0, ok: false, need: r.need, have: r.have };
      }
    }
    starts = r.starts; durs = r.durs;
  } else if (grid && project.fit === "music-to-show") {
    const r = snapToBeats(desired.map((d, i) => locked[i] ?? d), grid.beats, style.beatSync !== "off");
    starts = r.starts; durs = r.durs;
  } else {
    const r = snapToBeats(desired.map((d, i) => locked[i] ?? d), grid?.beats ?? [], !!grid && style.beatSync !== "off");
    starts = r.starts; durs = r.durs;
  }

  // Pass 6b: lay out the moves with the final durations, pass 7 transitions, validation.
  const slides: Slide[] = [];
  const beatLen = grid?.beatLen ?? style.pace.base / 4;
  let prevType: Slide["transitionIn"]["type"] | undefined;
  const looks = pickLooks(style, rng, units.length);
  units.forEach((u, i) => {
    const id = slideIds[i];
    const old = prior.get(id);
    const srng = rng.fork(id + ":layout");
    const dur = durs[i], start = starts[i];
    const isTitle = u.items.length === 0;
    const m = isTitle ? undefined : analysis.get(u.items[0])!;
    let treatment: Treatment, alternates: Treatment[] = [], reasons = [...chosen[i].reasons, ...durReasons[i]];
    if (keepLocks && old?.locks.treatment) { treatment = old.treatment; alternates = old.auto.alternates; }
    else if (isTitle || !m) treatment = { id: "hold", amount: 0, keys: [{ t: 0, view: [0, 0, 1], cam: [0, 0, 0], f: 1, ds: 0 }], k: 0, pivot: 0.5 };
    else {
      const inp = motionInput(m, aspect, project.output.height, style, dur);
      const amount = DEPTH_TREATMENTS.has(chosen[i].id) ? project.depthStrength * style.depthAmount : 1;
      const sec = secure(chosen[i].id, inp, srng, amount, chosen[i].dir);
      treatment = sec.treatment;
      if (treatment.id !== chosen[i].id) {
        // A fallback must not make the same treatment three in a row (spec §5.6 variety).
        const prev2 = slides.slice(-2).map((x) => x.treatment.id);
        if (prev2.length === 2 && prev2.every((x) => x === treatment.id)) treatment = secure(treatment.id === "pull" ? "hold" : "pull", inp, srng.fork("variety"), amount, chosen[i].dir).treatment;
      }
      if (treatment.id !== chosen[i].id) reasons.push(`${dur.toFixed(1)} s is too short for a ${TREATMENT_NAMES[chosen[i].id].toLowerCase()} → ${TREATMENT_NAMES[treatment.id].toLowerCase()}`);
      if (sec.repaired.includes("scaled")) reasons.push(`move reduced to keep the edge off screen`);
      if (sec.repaired.includes("face")) reasons.push("framing widened to keep the face in frame");
      alternates = chosen[i].alternates.map((aid) => secure(aid, inp, srng.fork(aid), amount, chosen[i].dir).treatment);
    }
    const sectionStart = grid ? grid.sections.has(nearestBeat(grid.beats, start)) : false;
    const tr = keepLocks && old?.locks.transition ? { ...old.transitionIn, reason: "locked" } : chooseTransition(style, srng, {
      major: major[i] || sectionStart, first: i === 0, flipbook: u.kind === "flipbook", beat: beatLen, tempoFast: (grid?.tempo ?? 100) > 130, hasDepth: !!m?.depth, hasMusic: !!grid, prevType,
    });
    prevType = tr.type;
    const maxTr = i === 0 ? dur * 0.6 : Math.min(dur, durs[i - 1]) * 0.6;
    const trDur = Math.min(tr.dur, maxTr);
    reasons.push(`${tr.type} (${tr.reason})`);
    const fill = keepLocks && old?.locks.fill ? old.fill : u.kind === "pair" ? "pair" : m && Math.abs(m.info.w / m.info.h / aspect - 1) > 0.25 ? (u.kind === "video" ? "blur" : treatment.id === "pan" ? "tilt" : "blur") : "cover";
    const look: LookId = keepLocks && old?.locks.look ? old.look : looks[i];
    const slide: Slide = {
      id, kind: isTitle ? "title" : u.kind, items: u.items, start, dur, treatment, fill, look,
      grade: style.grade?.film ?? 0,
      transitionIn: { type: tr.type, dur: trDur },
      caption: keepLocks && old?.locks.caption ? old.caption : isTitle ? { text: u.chapter === -1 ? project.titles.intro! : project.titles.end!, position: "center", style: "title" } : chapterStarts.has(i) && project.titles.chapters ? { text: chapterText(m), position: "bottom", style: "chapter", from: 0, to: Math.min(dur, 3.5) } : undefined,
      clip: u.kind === "video" && m?.info.duration ? clipPick(m, dur) : undefined,
      locks: keepLocks && old ? { ...old.locks } : {},
      auto: { reasons, alternates, quality: m?.depth ? "full" : "draft" },
      chapter: u.chapter,
    };
    slides.push(slide);
  });

  const duration = slides.length ? slides[slides.length - 1].start + slides[slides.length - 1].dur : 0;
  return { slides, warnings, mismatch, suggestedOut: cur.suggestedOut, alternates: cur.alternates, duration };
}

export function slideId(u: GroupedItem, i: number): string {
  if (!u.items.length) return u.chapter === -1 ? "title-intro" : "title-end";
  return "s" + hash32(u.items.join("+")).toString(16) + (u.kind === "pair" ? "p" : "");
}

export function motionInput(m: MediaAnalysis, aspect: number, outHeight: number, style: Style, dur: number): MotionInput {
  const faces = (m.faces ?? []).filter((f) => f.score >= 0.5).map((f) => f.box).sort((a, b) => boxArea(b) - boxArea(a));
  const peaks = (m.saliency?.peaks ?? []).map((p) => p.box);
  return {
    w: m.info.w, h: m.info.h, aspect, faces, pois: pointsOfInterest(faces, peaks),
    depth: m.depth ? { sep: m.depth.sep, pivot: m.depth.pivot, quality: m.depth.quality } : undefined,
    dur, panSpeed: style.panSpeed, resolutionScale: m.info.h / outHeight,
  };
}

const boxArea = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function explain(id: TreatmentId, inp: MotionInput, m: MediaAnalysis): string[] {
  const n = inp.faces.length;
  const who = n === 0 ? (inp.pois.length ? "a salient subject" : "no subject") : n === 1 ? "one face" : `${n} faces`;
  const wide = inp.w / inp.h / inp.aspect;
  const shape = wide > 1.35 ? "wider than the output" : wide < 0.75 ? "taller than the output" : "";
  return [`${who}${shape ? `, ${shape}` : ""} → ${id}${m.basics?.flags.includes("screenshot") ? " (readable)" : ""}`];
}

const titleDur = (text: string) => clamp(2 + 0.06 * text.length, 2.5, 6);

function chapterText(m: MediaAnalysis | undefined): string {
  if (!m?.info.taken) return "";
  return new Date(m.info.taken).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function estimateStart(desired: number[], total: number, n: number, i: number): number {
  const sum = desired.reduce((a, b) => a + b, 0);
  return (sum / Math.max(1, desired.length)) * i * (total / Math.max(total, (sum / Math.max(1, desired.length)) * n));
}

function nearestBeat(beats: number[], t: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < beats.length; i++) { const d = Math.abs(beats[i] - t); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

function pickLooks(style: Style, rng: Prng, n: number): LookId[] {
  const mix = style.look.mix;
  if (!mix) return Array(n).fill(style.look.default);
  const ids = Object.keys(mix) as LookId[], ws = ids.map((k) => mix[k] ?? 0);
  const out: LookId[] = [];
  for (let i = 0; i < n; i++) {
    let l = ids[rng.weighted(ws)];
    if (i > 0 && l !== "photo" && out[i - 1] !== "photo") l = "photo"; // creative looks never twice in a row
    out.push(l);
  }
  return out;
}

/** Clip length for a video unit: style-based, longer when speech is present (spec §7). */
function clipLength(m: MediaAnalysis, style: Style): number {
  const speech = m.videoScan?.samples.some((s) => s.speech > 0.5);
  const target = clamp(style.pace.base * (speech ? 1.6 : 1.1), 2, speech ? 9 : 6);
  return Math.min(target, m.info.duration ?? target);
}

/** Highlight picking (spec §7): the best window of the target length by faces, motion, steadiness, sharpness and speech. */
export function clipPick(m: MediaAnalysis, len: number): { in: number; out: number; speed: number; gain: number } {
  const dur = m.info.duration ?? len;
  len = Math.min(len, dur);
  const scan = m.videoScan;
  const speech = !!scan?.samples.some((s) => s.speech > 0.5);
  if (!scan || scan.samples.length < 2) return { in: Math.max(0, (dur - len) / 2), out: Math.max(0, (dur - len) / 2) + len, speed: 1, gain: speech ? 1 : 0 };
  const step = 1 / scan.fps;
  let best = 0, bs = -Infinity;
  for (let t = 0; t + len <= dur + 1e-6; t += 0.5) {
    let s = 0, n = 0;
    for (const x of scan.samples) {
      if (x.t < t || x.t > t + len) continue;
      s += x.faces * 0.5 + x.faceSize * 2 + (x.motion > 0.05 && x.motion < 0.5 ? 0.5 : 0) - x.shake * 0.8 + Math.min(1, x.sharpness / 300) * 0.5 + x.speech * 0.6;
      n++;
    }
    s = n ? s / n : -1;
    // Don't cut mid-sentence: edges that land in speech cost.
    const edgeIn = scan.samples.find((x) => Math.abs(x.t - t) < step), edgeOut = scan.samples.find((x) => Math.abs(x.t - (t + len)) < step);
    if (edgeIn && edgeIn.speech > 0.5) s -= 0.4;
    if (edgeOut && edgeOut.speech > 0.5) s -= 0.4;
    if (s > bs) { bs = s; best = t; }
  }
  return { in: best, out: best + len, speed: 1, gain: speech ? 1 : 0 };
}

const fmt = (s: number) => { const m = Math.floor(s / 60), r = Math.round(s - m * 60); return `${m}:${r < 10 ? "0" : ""}${r}`; };

/** Re-layout one slide's treatment at a new id (the inspector's "Try another" and manual picks). */
export function relayout(project: Project, slide: Slide, m: MediaAnalysis, id: TreatmentId, amount: number, direction: number): Treatment {
  const style = resolveStyle(project.styleId, project.styleOverrides);
  const inp = motionInput(m, ASPECTS[project.output.aspect], project.output.height, style, slide.dur);
  const rng = new Prng(hash32(slide.id + id + project.seed));
  return secure(id, inp, rng, amount, direction).treatment;
}

export { layout };
