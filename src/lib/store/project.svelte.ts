// App state (Svelte 5 runes): the open project, its analysis, the timeline, undo and autosave.
// Every edit goes through `edit()`, which records an undo step, locks the edited field on the
// slide (spec §8.2) and autosaves.
import { AnalysisQueue, loadAnalysis, type StageStatus } from "$lib/analysis/queue";
import { compile } from "$lib/planner/compile";
import { plan, relayout, type PlanResult } from "$lib/planner/plan";
import { resolveStyle } from "$lib/planner/styles";
import type { Aspect, Fps, LockField, MediaAnalysis, MusicAnalysis, OutHeight, Project, Slide, Timeline, TreatmentId } from "$lib/planner/types";
import { uid } from "$lib/util/id";
import { mediaDb, projectsDb, songsDb, type MediaRecord, type SongRecord } from "./db";

export const BASE = import.meta.env.BASE_URL;

export function newProject(title = "Untitled show"): Project {
  return {
    v: 1, id: uid("p"), title, seed: (Math.random() * 0x7fffffff) >>> 0, created: Date.now(), updated: Date.now(),
    output: { aspect: "16:9", height: 1080, fps: 30 }, styleId: "classic", styleOverrides: {},
    media: [], excluded: [], starred: [], order: "time", songs: [], fit: "show-to-music", slides: [],
    titles: { chapters: false }, generativeFill: "off", beatSync: "cuts", depthStrength: 1,
  };
}

class AppState {
  project = $state<Project | null>(null);
  analysis = $state(new Map<string, MediaAnalysis>());
  music = $state(new Map<string, MusicAnalysis>());
  songs = $state(new Map<string, SongRecord>());
  records = $state(new Map<string, MediaRecord>());
  stageStatus = $state(new Map<string, StageStatus["status"]>());
  timeline = $state<Timeline | null>(null);
  planResult = $state<PlanResult | null>(null);
  selected = $state<string[]>([]);
  playhead = $state(0);
  playing = $state(false);
  dirty = $state(false);
  busy = $state<string | null>(null);
  toast = $state<string | null>(null);
  userEdited = $state(false);
  pendingUpgrade = $state(0);
  queue: AnalysisQueue | null = null;
  private undo: Project[] = [];
  private redo: Project[] = [];
  private saveTimer = 0;
  private unsub: (() => void) | null = null;
  private facesPending = new Set<string>();
  private replanTimer = 0;

  get style() { return this.project ? resolveStyle(this.project.styleId, this.project.styleOverrides) : null; }
  get canUndo() { return this.undo.length > 0; }
  get canRedo() { return this.redo.length > 0; }

  ensureQueue(): AnalysisQueue {
    if (!this.queue) {
      this.queue = new AnalysisQueue({ base: BASE });
      this.unsub = this.queue.onStatus((s) => this.onStage(s));
    }
    return this.queue;
  }

  private onStage(s: StageStatus): void {
    this.stageStatus.set(`${s.hash}|${s.stage}`, s.status);
    this.stageStatus = new Map(this.stageStatus);
    if (s.status === "ok" && this.project?.media.includes(s.hash)) {
      this.facesPending.add(s.hash);
      clearTimeout(this.replanTimer);
      this.replanTimer = window.setTimeout(() => void this.absorbAnalysis(), 400);
    }
  }

  /** Pull fresh analysis results in; re-plan automatically until the user's first edit. */
  private async absorbAnalysis(): Promise<void> {
    const hashes = [...this.facesPending];
    this.facesPending.clear();
    for (const h of hashes) {
      const a = await loadAnalysis(h);
      if (a) this.analysis.set(h, a);
    }
    this.analysis = new Map(this.analysis);
    if (!this.project) return;
    if (!this.userEdited) this.replan({ silent: true });
    else this.pendingUpgrade += hashes.length;
  }

  async open(id: string): Promise<boolean> {
    const p = await projectsDb.get(id);
    if (!p) return false;
    await this.load(p);
    return true;
  }

  async load(p: Project): Promise<void> {
    this.project = p;
    this.undo = []; this.redo = [];
    this.userEdited = false;
    this.pendingUpgrade = 0;
    this.selected = [];
    this.playhead = 0;
    await this.refreshMedia(p.media);
    await this.refreshSongs(p.songs.map((s) => s.hash));
    this.ensureQueue().enqueue(p.media);
    if (p.slides.length) this.recompile(); else this.replan({ silent: true });
  }

  async refreshMedia(hashes: string[]): Promise<void> {
    const recs = await mediaDb.getMany(hashes);
    for (const [h, r] of recs) this.records.set(h, r);
    this.records = new Map(this.records);
    for (const h of hashes) {
      const a = await loadAnalysis(h);
      if (a) this.analysis.set(h, a);
    }
    this.analysis = new Map(this.analysis);
  }

  async refreshSongs(hashes: string[]): Promise<void> {
    for (const h of hashes) {
      const s = await songsDb.get(h);
      if (s) { this.songs.set(h, s); if (s.analysis) this.music.set(h, s.analysis); }
    }
    this.songs = new Map(this.songs); this.music = new Map(this.music);
  }

  /** Add media to the project (after import). */
  async addMedia(hashes: string[], songHashes: string[]): Promise<void> {
    if (!this.project) return;
    await this.refreshMedia(hashes);
    await this.refreshSongs(songHashes);
    const p = this.project;
    const fresh = hashes.filter((h) => !p.media.includes(h));
    p.media = [...p.media, ...fresh];
    for (const h of songHashes) if (!p.songs.some((s) => s.hash === h)) p.songs.push({ hash: h, trimIn: 0, trimOut: 0, gain: 1, fadeIn: 0, fadeOut: 3 });
    this.ensureQueue().enqueue(fresh);
    this.project = p;
    this.replan({ silent: true });
  }

  replan(opts: { silent?: boolean; newSeed?: boolean } = {}): void {
    const p = this.project;
    if (!p) return;
    if (!opts.silent) this.pushUndo();
    if (opts.newSeed) p.seed = (Math.random() * 0x7fffffff) >>> 0;
    const r = plan(p, this.analysis, this.music);
    p.slides = r.slides;
    this.planResult = r;
    this.project = p;
    this.pendingUpgrade = 0;
    this.recompile();
    this.save();
  }

  recompile(): void {
    if (!this.project) return;
    this.timeline = compile(this.project, this.analysis, this.music);
  }

  private pushUndo(): void {
    if (!this.project) return;
    this.undo.push(structuredClone($state.snapshot(this.project)) as Project);
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
  }

  /** Apply an edit to the project; `locks` names the slide fields the edit locks. */
  edit(fn: (p: Project) => void, locks?: { slideId: string; fields: LockField[] }, opts: { replan?: boolean } = {}): void {
    const p = this.project;
    if (!p) return;
    this.pushUndo();
    fn(p);
    if (locks) {
      const s = p.slides.find((x) => x.id === locks.slideId);
      if (s) for (const f of locks.fields) s.locks[f] = true;
    }
    this.userEdited = true;
    p.updated = Date.now();
    if (opts.replan) { const r = plan(p, this.analysis, this.music); p.slides = r.slides; this.planResult = r; }
    else this.ripple(p);
    this.project = p;
    this.recompile();
    this.save();
  }

  /** Keep slide starts contiguous after a duration or order change. */
  private ripple(p: Project): void {
    let t = 0;
    for (const s of p.slides) { s.start = t; t += s.dur; }
  }

  undoEdit(): void {
    const p = this.undo.pop();
    if (!p || !this.project) return;
    this.redo.push(structuredClone($state.snapshot(this.project)) as Project);
    this.project = p; this.recompile(); this.save();
  }
  redoEdit(): void {
    const p = this.redo.pop();
    if (!p || !this.project) return;
    this.undo.push(structuredClone($state.snapshot(this.project)) as Project);
    this.project = p; this.recompile(); this.save();
  }

  unlock(slideId: string, field: LockField): void {
    this.edit((p) => { const s = p.slides.find((x) => x.id === slideId); if (s) delete s.locks[field]; });
  }

  setTreatment(slide: Slide, id: TreatmentId, amount = slide.treatment.amount, direction = slide.treatment.direction ?? 1): void {
    const m = this.analysis.get(slide.items[0]);
    if (!m || !this.project) return;
    const t = relayout(this.project, slide, m, id, amount, direction);
    this.edit((p) => { const s = p.slides.find((x) => x.id === slide.id); if (s) s.treatment = t; }, { slideId: slide.id, fields: ["treatment"] });
  }

  tryAnother(slide: Slide): void {
    const alts = slide.auto.alternates;
    if (!alts.length) return;
    const next = alts[0];
    this.edit((p) => {
      const s = p.slides.find((x) => x.id === slide.id);
      if (!s) return;
      s.auto.alternates = [...alts.slice(1), s.treatment];
      s.treatment = next;
    }, { slideId: slide.id, fields: ["treatment"] });
  }

  setOutput(o: Partial<{ aspect: Aspect; height: OutHeight; fps: Fps }>): void {
    this.edit((p) => { Object.assign(p.output, o); }, undefined, { replan: true });
  }

  save(): void {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 500);
  }

  async saveNow(): Promise<void> {
    if (!this.project) return;
    this.project.updated = Date.now();
    await projectsDb.put(structuredClone($state.snapshot(this.project)) as Project);
    this.dirty = false;
  }

  say(msg: string, ms = 3500): void {
    this.toast = msg;
    window.setTimeout(() => { if (this.toast === msg) this.toast = null; }, ms);
  }

  /** Analysis progress for the UI ("faces found for 84 of 120"). */
  progress(): { basics: number; faces: number; depth: number; total: number } {
    const p = this.project;
    if (!p) return { basics: 0, faces: 0, depth: 0, total: 0 };
    let b = 0, f = 0, d = 0;
    for (const h of p.media) {
      if (this.stageStatus.get(`${h}|basics`) === "ok" || this.analysis.get(h)?.basics) b++;
      const fs = this.stageStatus.get(`${h}|faces`);
      if (fs === "ok" || fs === "skipped" || this.analysis.get(h)?.faces) f++;
      const ds = this.stageStatus.get(`${h}|depth`);
      if (ds === "ok" || ds === "skipped" || ds === "error" || this.analysis.get(h)?.depth) d++;
    }
    return { basics: b, faces: f, depth: d, total: p.media.length };
  }

  close(): void {
    this.project = null; this.timeline = null; this.planResult = null;
    this.unsub?.(); this.unsub = null;
  }
}

export const app = new AppState();
