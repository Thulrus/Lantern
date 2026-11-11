// The audio mix (spec §6.5, §10.2): the same graph for preview (AudioContext) and export
// (OfflineAudioContext), built from the timeline's audio events: songs with trims, fades and
// crossfades, clip audio, and ducking envelopes.
import type { AudioEvent, Timeline } from "$lib/planner/types";

export interface MixSource { buffer: AudioBuffer }

/** Schedule every event that overlaps [from, to) on the context, starting at context time `at0`. */
export function schedule(ctx: BaseAudioContext, tl: Timeline, buffers: Map<string, AudioBuffer>, from: number, at0: number, master: AudioNode): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = [];
  for (const ev of tl.audio) {
    const buf = buffers.get(ev.src);
    if (!buf) continue;
    const evEnd = ev.at + (ev.out - ev.in);
    if (evEnd <= from) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const duck = ctx.createGain();
    src.connect(gain).connect(duck).connect(master);
    applyEnvelope(gain.gain, ev.gain.points, from, at0);
    if (ev.duck) applyEnvelope(duck.gain, ev.duck.points, from, at0, 1);
    const startShow = Math.max(ev.at, from);
    const offset = ev.in + (startShow - ev.at);
    const dur = Math.max(0, ev.out - offset);
    if (dur <= 0) continue;
    src.start(at0 + (startShow - from), offset, dur);
    nodes.push(src);
  }
  return nodes;
}

function applyEnvelope(param: AudioParam, pts: [number, number][], from: number, at0: number, initial = 0): void {
  // Value at `from` by interpolation, then linear ramps for later points.
  let v = initial;
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length; i++) {
    const [t, g] = sorted[i];
    if (t <= from) { v = g; continue; }
    const prev = sorted[i - 1];
    if (prev && prev[0] < from) v = prev[1] + ((g - prev[1]) * (from - prev[0])) / Math.max(t - prev[0], 1e-6);
    break;
  }
  param.setValueAtTime(v, at0);
  for (const [t, g] of sorted) if (t > from) param.linearRampToValueAtTime(g, at0 + (t - from));
}

export function eventSources(tl: Timeline): string[] {
  return Array.from(new Set(tl.audio.map((e) => e.src)));
}

/** Render the whole mix offline (export). */
export async function renderMix(tl: Timeline, buffers: Map<string, AudioBuffer>, sampleRate = 48000): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(tl.dur * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);
  schedule(ctx, tl, buffers, 0, 0, master);
  return ctx.startRendering();
}

export const eventsFor = (tl: Timeline): AudioEvent[] => tl.audio;
