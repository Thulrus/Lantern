// App state (Svelte 5 runes): the open project, its analysis, the timeline, undo and autosave.
// Every edit goes through `edit()`, which records an undo step, locks the edited field on the
// slide (spec §8.2) and autosaves.
import { invalidateLayers, setGeneratedPlates } from "$lib/render/assets";
import { AnalysisQueue, loadAnalysis, type Activity, type StageId, type StageStatus } from "$lib/analysis/queue";
import { compile } from "$lib/planner/compile";
import { plan, relayout, type PlanResult } from "$lib/planner/plan";
import { resolveStyle } from "$lib/planner/styles";
import type { Aspect, CamKey, Fps, LockField, MediaAnalysis, MusicAnalysis, OutHeight, Project, Slide, Timeline, TreatmentId } from "$lib/planner/types";
import { uid } from "$lib/util/id";
import { analysisDb, mediaDb, projectsDb, songsDb, type MediaRecord, type SongRecord } from "./db";

export const BASE = import.meta.env.BASE_URL;

/** The generative fill choice is remembered for new shows (this browser only). */
const FILL_PREF = "lantern.generativeFill";
function fillPref(): Project["generativeFill"] {
  try { return localStorage.getItem(FILL_PREF) === "all" ? "all" : "off"; } catch { return "off"; }
}

/** One analysis stage's progress over the open show's media. `done` counts finished items
 *  (skipped ones, such as videos for the model stages, included). */
export interface StageProgress { id: StageId; on: boolean; done: number; errors: number; skipped: number; running: number; total: number; firstError?: string }
export interface Pipeline { stages: StageProgress[]; busy: boolean; etaS: number | null }

export function newProject(title = "Untitled show"): Project {
  return {
    v: 1, id: uid("p"), title, seed: (Math.random() * 0x7fffffff) >>> 0, created: Date.now(), updated: Date.now(),
    output: { aspect: "16:9", height: 1080, fps: 30 }, styleId: "classic", styleOverrides: {},
    media: [], excluded: [], starred: [], order: "time", songs: [], fit: "show-to-music", slides: [],
    titles: { chapters: false }, generativeFill: fillPref(), beatSync: "cuts", depthStrength: 1,
  };
}

class AppState {
  project = $state<Project | null>(null);
  analysis = $state(new Map<string, MediaAnalysis>());
  music = $state(new Map<string, MusicAnalysis>());
  songs = $state(new Map<string, SongRecord>());
  records = $state(new Map<string, MediaRecord>());
  stageStatus = $state(new Map<string, StageStatus["status"]>());
  /** What each analysis worker is doing right now (downloads, model loads, the photo in hand). */
  activity = $state<Activity[]>([]);
  private stageErrors = new Map<string, string>();
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
      const a = this.queue.onStatus((s) => this.onStage(s));
      const b = this.queue.onActivity((x) => (this.activity = x));
      this.unsub = () => { a(); b(); };
    }
    return this.queue;
  }

  private onStage(s: StageStatus): void {
    this.stageStatus.set(`${s.hash}|${s.stage}`, s.status);
    this.stageStatus = new Map(this.stageStatus);
    if (s.status === "error" && s.error) this.stageErrors.set(`${s.hash}|${s.stage}`, s.error);
    else this.stageErrors.delete(`${s.hash}|${s.stage}`);
    if ((s.stage === "fill" || s.stage === "depth") && s.status === "ok") invalidateLayers(s.hash);
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
    this.applyFill();
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

  /** Whether generative fill runs: chosen ("all"; margins are not built yet, spec §4.6) and the
   *  style has 3D moves, the only thing that shows the plates behind people. */
  get fillActive(): boolean {
    return this.project?.generativeFill === "all" && (this.style?.depthShare ?? 0) > 0;
  }

  /** Start or stop the fill stage to match the project; called after every change. */
  private applyFill(): void {
    if (!this.project) return;
    const on = this.fillActive;
    setGeneratedPlates(on);
    this.ensureQueue().setFill(on, this.project.media);
  }

  /** Pick a style (the Make screen: not an edit, the show is planned afterwards). */
  setStyle(id: string): void {
    if (!this.project) return;
    this.project.styleId = id;
    this.applyFill();
    this.save();
  }

  setGenerativeFill(v: Project["generativeFill"]): void {
    // Not a plan edit: analysis results keep re-planning the show by themselves afterwards.
    const edited = this.userEdited;
    this.edit((p) => { p.generativeFill = v; });
    this.userEdited = edited;
    try { localStorage.setItem(FILL_PREF, v); } catch { /* storage blocked: the show keeps its own setting */ }
  }

  /** Run the model stages (faces, depth, fill) again for the show's photos: their cached results
   *  are dropped and the queue starts over. The current results stay in use until new ones land. */
  async reanalyse(): Promise<void> {
    const p = this.project;
    if (!p) return;
    const stages: StageId[] = ["faces", "depth", "fill"];
    const q = this.ensureQueue();
    q.forget(p.media, stages);
    await analysisDb.removeStages(p.media, stages);
    for (const h of p.media) for (const st of stages) { this.stageStatus.delete(`${h}|${st}`); this.stageErrors.delete(`${h}|${st}`); }
    this.stageStatus = new Map(this.stageStatus);
    q.enqueue(p.media);
    this.applyFill();
  }

  /** After the analysis cache is cleared (Settings): forget every result and start the open show over. */
  restartAnalysis(): void {
    this.queue?.forgetAll();
    this.stageStatus = new Map();
    this.stageErrors.clear();
    if (this.project) { this.ensureQueue().enqueue(this.project.media); this.applyFill(); }
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
    this.applyFill();
    this.recompile();
    this.save();
  }

  /** Remove the selected slides. Photos go to `excluded`; title cards are removed at their source so the planner does not bring them back. */
  removeSelected(): void {
    const ids = [...this.selected];
    if (!ids.length || !this.project) return;
    const titles = ids.filter((id) => id.startsWith("title-"));
    this.edit((p) => {
      for (const s of p.slides) if (ids.includes(s.id)) p.excluded.push(...s.items);
      p.slides = p.slides.filter((s) => !ids.includes(s.id));
      for (const id of titles) {
        if (id === "title-intro") p.titles.intro = undefined;
        else if (id === "title-end") p.titles.end = undefined;
        else p.titles.cards = (p.titles.cards ?? []).filter((c) => "title-" + c.id !== id);
      }
    });
    this.selected = [];
  }

  /** Add a title card before the given slide (or at the end) and select it. */
  addTitleCard(before?: Slide, text = "Title"): void {
    const id = uid("c");
    const anchor = before?.items[0];
    this.edit((p) => { p.titles.cards = [...(p.titles.cards ?? []), { id, text, before: anchor }]; }, undefined, { replan: true });
    this.selected = ["title-" + id];
  }

  /** Change a title card's text at its source (intro, end or a user card). */
  setTitleText(slideId: string, text: string): void {
    this.edit((p) => {
      if (slideId === "title-intro") p.titles.intro = text || undefined;
      else if (slideId === "title-end") p.titles.end = text || undefined;
      else { const c = p.titles.cards?.find((x) => "title-" + x.id === slideId); if (c) c.text = text; }
    }, undefined, { replan: true });
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
    this.project = p; this.applyFill(); this.recompile(); this.save();
  }
  redoEdit(): void {
    const p = this.redo.pop();
    if (!p || !this.project) return;
    this.undo.push(structuredClone($state.snapshot(this.project)) as Project);
    this.project = p; this.applyFill(); this.recompile(); this.save();
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

  /** Framing editor: replace a slide's camera keys (or, for a pair, both photos' keys) and lock its motion. */
  setFraming(slideId: string, patch: { keys?: CamKey[]; cells?: [CamKey[], CamKey[]] }): void {
    this.edit((p) => {
      const s = p.slides.find((x) => x.id === slideId);
      if (!s) return;
      if (patch.keys) s.treatment.keys = patch.keys;
      if (patch.cells) s.treatment.cells = patch.cells;
    }, { slideId, fields: ["treatment"] });
  }

  /** Framing editor's reset: lay the slide's move out again automatically. */
  resetFraming(slide: Slide): void {
    if (slide.kind === "pair") {
      this.edit((p) => { const s = p.slides.find((x) => x.id === slide.id); if (s) { delete s.treatment.cells; delete s.locks.treatment; } });
    } else this.setTreatment(slide, slide.treatment.id);
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

  /** Per-stage progress for the analysis panel, plus a rough time left from recent job times. */
  pipeline(): Pipeline {
    const p = this.project;
    const fillOn = this.fillActive;
    const ids: StageId[] = ["basics", "faces", "depth", "fill"];
    const stages = ids.map((id): StageProgress => {
      const sp: StageProgress = { id, on: id !== "fill" || fillOn, done: 0, errors: 0, skipped: 0, running: 0, total: p?.media.length ?? 0 };
      for (const h of p?.media ?? []) {
        const st = this.stageStatus.get(`${h}|${id}`);
        const a = this.analysis.get(h);
        const have = id === "basics" ? !!a?.basics : id === "faces" ? !!a?.faces : id === "depth" ? !!a?.depth : false;
        if (st === "error") { sp.errors++; sp.firstError ??= this.stageErrors.get(`${h}|${id}`); }
        else if (st === "skipped") { sp.skipped++; sp.done++; }
        else if (st === "ok" || (!st && have)) sp.done++;
        else if (st === "running") sp.running++;
      }
      return sp;
    });
    const live = stages.filter((s) => s.on && s.done + s.errors < s.total);
    let eta: number | null = 0;
    for (const s of live) {
      const ms = this.queue?.stageMs(s.id) ?? null;
      if (ms === null) { eta = null; break; }
      eta += (s.total - s.done - s.errors) * ms;
    }
    const workers = this.queue?.workerCount ?? 1;
    return { stages, busy: live.length > 0, etaS: eta === null ? null : eta / 1000 / workers };
  }

  close(): void {
    this.project = null; this.timeline = null; this.planResult = null;
    this.unsub?.(); this.unsub = null;
  }
}

export const app = new AppState();
// A debug handle for tests and the console (the app is browser-only; nothing leaves the device).
Object.assign(globalThis, { lantern: app });

