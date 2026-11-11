// Preview playback (spec §3): a requestAnimationFrame clock advances show time; the renderer
// draws frame = f(timeline, t); songs play through a Web Audio graph built from the same audio
// events the export uses. The clock is the AudioContext's when audio plays, so picture and
// sound stay locked.
import type { Timeline } from "$lib/planner/types";
import { schedule } from "$lib/audio/mixer";
import { AssetLoader } from "./assets";
import { Renderer } from "./renderer";

export class Player {
  renderer: Renderer;
  assets: AssetLoader;
  timeline: Timeline | null = null;
  time = 0;
  playing = false;
  private raf = 0;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioBufferSourceNode[] = [];
  private audioAt = 0;     // show time when audio was started
  private ctxAt = 0;       // context time when audio was started
  private wall = 0;        // performance.now at the last tick (no-audio clock)
  buffers = new Map<string, AudioBuffer>();
  onTime: ((t: number) => void) | null = null;
  onEnd: (() => void) | null = null;
  volume = 1;
  private dirty = true;
  private drawing = false;
  frameTimes: number[] = [];

  constructor(public canvas: HTMLCanvasElement, lite = false) {
    this.renderer = new Renderer(canvas, { lite });
    this.assets = new AssetLoader(this.renderer, { budget: lite ? 10 : 24 });
    this.loop = this.loop.bind(this);
  }

  setTimeline(tl: Timeline): void {
    this.timeline = tl;
    this.time = Math.min(this.time, tl.dur);
    this.dirty = true;
    if (this.playing) this.restartAudio();
    this.requestFrame();
  }

  resize(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) { this.canvas.width = w; this.canvas.height = h; this.dirty = true; this.requestFrame(); }
  }

  async play(): Promise<void> {
    if (!this.timeline || this.playing) return;
    if (this.time >= this.timeline.dur - 0.01) this.time = 0;
    this.playing = true;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.master ??= (() => { const g = this.ctx!.createGain(); g.connect(this.ctx!.destination); return g; })();
    this.master.gain.value = this.volume;
    this.restartAudio();
    this.wall = performance.now();
    this.requestFrame();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stopAudio();
    this.requestFrame();
  }

  toggle(): void { if (this.playing) this.pause(); else void this.play(); }

  seek(t: number): void {
    if (!this.timeline) return;
    this.time = Math.max(0, Math.min(this.timeline.dur, t));
    if (this.playing) this.restartAudio();
    this.dirty = true;
    this.requestFrame();
  }

  setVolume(v: number): void { this.volume = v; if (this.master) this.master.gain.value = v; }

  private stopAudio(): void {
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.nodes = [];
  }

  private restartAudio(): void {
    this.stopAudio();
    if (!this.ctx || !this.master || !this.timeline) return;
    this.audioAt = this.time;
    this.ctxAt = this.ctx.currentTime + 0.05;
    this.nodes = schedule(this.ctx, this.timeline, this.buffers, this.time, this.ctxAt, this.master);
    this.wall = performance.now();
  }

  requestFrame(): void { if (!this.raf) this.raf = requestAnimationFrame(this.loop); }

  private async loop(): Promise<void> {
    this.raf = 0;
    const tl = this.timeline;
    if (!tl) return;
    if (this.playing) {
      const now = performance.now();
      if (this.ctx && this.nodes.length) this.time = this.audioAt + Math.max(0, this.ctx.currentTime - this.ctxAt);
      else this.time += (now - this.wall) / 1000;
      this.wall = now;
      if (this.time >= tl.dur) { this.time = tl.dur; this.playing = false; this.stopAudio(); this.onEnd?.(); }
      this.dirty = true;
    }
    if (this.dirty && !this.drawing) {
      this.drawing = true;
      this.dirty = false;
      const t0 = performance.now();
      try {
        await this.assets.ensure(tl, this.time);
        this.assets.tickVideo(tl, this.time, this.playing);
        this.renderer.draw(tl, this.time);
      } finally {
        this.drawing = false;
      }
      this.frameTimes.push(performance.now() - t0);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
      this.onTime?.(this.time);
    }
    if (this.playing || this.dirty) this.requestFrame();
  }

  /** Draw the current frame to a blob (the "export this frame" feature). */
  async snapshot(): Promise<Blob> {
    if (this.timeline) this.renderer.draw(this.timeline, this.time);
    return new Promise((res, rej) => this.canvas.toBlob((b) => (b ? res(b) : rej(new Error("no frame"))), "image/jpeg", 0.92));
  }

  dispose(): void {
    this.pause();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.assets.dispose();
    this.renderer.dispose();
    this.ctx?.close();
  }
}
