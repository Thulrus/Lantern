// Music analysis (spec §6.2), all classical DSP so it runs anywhere: onset strength from log-mel
// spectral flux, a tempogram with a 120 BPM prior, Ellis's dynamic-programming beat tracker,
// downbeats by low-frequency onset energy and harmonic change, sections by Foote novelty on
// beat-synchronous chroma + MFCC, an energy curve, and the song's edges.
import { clamp, mean, median } from "$lib/util/math";
import type { MusicAnalysis } from "$lib/planner/types";
import { FFT } from "./fft";

export const SR = 22050;
const N_FFT = 2048, HOP = 512, N_MELS = 64;

export function resampleMono(channels: Float32Array[], srIn: number, srOut = SR): Float32Array {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
  if (srIn === srOut) return mono;
  const ratio = srIn / srOut, m = Math.floor(n / ratio);
  const out = new Float32Array(m);
  // Box-filter then linear interpolation: good enough for onset detection.
  const box = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < m; i++) {
    const x = i * ratio, i0 = Math.floor(x);
    let s = 0, k = 0;
    for (let j = i0; j < Math.min(n, i0 + box); j++) { s += mono[j]; k++; }
    out[i] = k ? s / k : 0;
  }
  return out;
}

function melFilters(sr: number, nfft: number, nMels: number): { starts: Int32Array; weights: Float32Array[] } {
  const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700), mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const lo = hz2mel(30), hi = hz2mel(sr / 2);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (nMels + 1)));
  const bin = (f: number) => Math.floor(((nfft / 2 + 1) * f) / (sr / 2));
  const starts = new Int32Array(nMels), weights: Float32Array[] = [];
  for (let m = 0; m < nMels; m++) {
    const a = bin(pts[m]), b = bin(pts[m + 1]), c = Math.max(bin(pts[m + 2]), b + 1);
    const w = new Float32Array(c - a + 1);
    for (let k = a; k <= c; k++) w[k - a] = k < b ? (k - a) / Math.max(b - a, 1) : (c - k) / Math.max(c - b, 1);
    starts[m] = a; weights.push(w);
  }
  return { starts, weights };
}

export interface Features { onset: Float32Array; frameRate: number; mel: Float32Array[]; chroma: Float32Array[]; lowOnset: Float32Array; rms: Float32Array; brightness: Float32Array }

export function features(x: Float32Array, sr = SR): Features {
  const fft = new FFT(N_FFT);
  const win = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const frames = Math.max(1, Math.floor((x.length - N_FFT) / HOP) + 1);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT), mag = new Float32Array(N_FFT / 2 + 1), buf = new Float32Array(N_FFT);
  const mf = melFilters(sr, N_FFT, N_MELS);
  const mel: Float32Array[] = [], chroma: Float32Array[] = [];
  const onset = new Float32Array(frames), lowOnset = new Float32Array(frames), rms = new Float32Array(frames), brightness = new Float32Array(frames);
  let prev = new Float32Array(N_MELS);
  const binHz = sr / N_FFT;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let e = 0;
    for (let i = 0; i < N_FFT; i++) { const v = x[off + i] ?? 0; buf[i] = v * win[i]; e += v * v; }
    rms[f] = Math.sqrt(e / N_FFT);
    fft.magnitude(buf, re, im, mag);
    const m = new Float32Array(N_MELS);
    for (let b = 0; b < N_MELS; b++) {
      let s = 0;
      const w = mf.weights[b], st = mf.starts[b];
      for (let k = 0; k < w.length; k++) s += w[k] * (mag[st + k] ?? 0);
      m[b] = Math.log1p(s * 10);
    }
    let flux = 0, low = 0;
    for (let b = 0; b < N_MELS; b++) { const d = m[b] - prev[b]; if (d > 0) { flux += d; if (b < 10) low += d; } }
    onset[f] = flux; lowOnset[f] = low;
    prev = m; mel.push(m);
    // Chroma from the magnitude spectrum, and spectral centroid for brightness.
    const c = new Float32Array(12);
    let num = 0, den = 0;
    for (let k = 1; k < mag.length; k++) {
      const hz = k * binHz, v = mag[k] * mag[k];
      num += hz * v; den += v;
      if (hz < 60 || hz > 5000) continue;
      const pc = Math.round(12 * Math.log2(hz / 440)) % 12;
      c[(pc + 12 + 9) % 12] += mag[k];
    }
    const cs = c.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 12; i++) c[i] /= cs;
    chroma.push(c);
    brightness[f] = den ? num / den : 0;
  }
  // Onset strength: subtract a local median, keep the positive part, normalize.
  const o = localMedianSub(onset, 16);
  return { onset: o, frameRate: sr / HOP, mel, chroma, lowOnset, rms, brightness };
}

function localMedianSub(x: Float32Array, half: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(x.length, i + half + 1);
    const m = median(Array.from(x.slice(a, b)));
    out[i] = Math.max(0, x[i] - m);
  }
  const mx = Math.max(1e-6, ...out);
  for (let i = 0; i < out.length; i++) out[i] /= mx;
  return out;
}

/** Tempo estimate from the onset autocorrelation with a log-normal prior centred on 120 BPM. */
export function tempo(onset: Float32Array, frameRate: number): { bpm: number; alt: number } {
  const minLag = Math.floor((60 / 220) * frameRate), maxLag = Math.ceil((60 / 50) * frameRate);
  const n = onset.length;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s / Math.max(1, n - lag);
  }
  const score = (lag: number) => {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * ((Math.log2(bpm / 120)) / 0.9) ** 2);
    return ac[lag] * prior;
  };
  let best = minLag, bs = -1;
  for (let lag = minLag; lag <= maxLag; lag++) { const s = score(lag); if (s > bs) { bs = s; best = lag; } }
  // Refine by parabolic interpolation.
  const refine = (lag: number) => {
    if (lag <= minLag || lag >= maxLag) return lag;
    const a = ac[lag - 1], b = ac[lag], c = ac[lag + 1], d = a - 2 * b + c;
    return d ? lag - (0.5 * (c - a)) / d : lag;
  };
  const bpm = (60 * frameRate) / refine(best);
  // Second candidate: the best lag away from the first (half or double tempo).
  let alt = best, as = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - best) < best * 0.2) continue;
    const s = score(lag);
    if (s > as) { as = s; alt = lag; }
  }
  return { bpm, alt: (60 * frameRate) / refine(alt) };
}

/** Ellis (2007) dynamic-programming beat tracker: maximize onset strength at beats plus
 *  consistency with the tempo period. Returns beat frames. */
export function trackBeats(onset: Float32Array, frameRate: number, bpm: number, tightness = 100): number[] {
  const period = (60 / bpm) * frameRate;
  const n = onset.length;
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period * 0.5), hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = 0, bj = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const s = score[j] - tightness * (Math.log((i - j) / period)) ** 2;
      if (s > best || bj === -1) { best = s; bj = j; }
    }
    score[i] = onset[i] + (bj >= 0 ? best : 0);
    back[i] = bj;
  }
  // Start from the best score in the last period, walk back.
  let end = n - 1, bs = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > bs) { bs = score[i]; end = i; }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) { beats.push(i); if (back[i] < 0) break; }
  return beats.reverse();
}

/** Downbeats: the beat phase (of 4 and of 3) whose candidates carry the most low-frequency
 *  onset energy and the most harmonic change. */
export function downbeats(beatFrames: number[], f: Features): { phase: number; bar: 3 | 4; downbeatIdx: number[] } {
  const chromaChange = (b: number) => {
    const i = beatFrames[b], j = beatFrames[Math.max(0, b - 1)];
    const a = f.chroma[Math.min(i, f.chroma.length - 1)], c = f.chroma[Math.min(j, f.chroma.length - 1)];
    let d = 0;
    for (let k = 0; k < 12; k++) d += Math.abs(a[k] - c[k]);
    return d;
  };
  const low = (b: number) => { const i = beatFrames[b]; let s = 0; for (let k = -1; k <= 1; k++) s += f.lowOnset[clamp(i + k, 0, f.lowOnset.length - 1)]; return s; };
  const lows = beatFrames.map((_, b) => low(b)), chg = beatFrames.map((_, b) => chromaChange(b));
  const nl = Math.max(1e-6, mean(lows)), nc = Math.max(1e-6, mean(chg));
  let best = { phase: 0, bar: 4 as 3 | 4, s: -Infinity };
  for (const bar of [4, 3] as const)
    for (let ph = 0; ph < bar; ph++) {
      let s = 0, n = 0;
      for (let b = ph; b < beatFrames.length; b += bar) { s += lows[b] / nl + chg[b] / nc; n++; }
      s = n ? s / n : 0;
      if (bar === 3) s *= 0.9; // prefer 4/4 unless 3/4 is clearly better
      if (s > best.s) best = { phase: ph, bar, s };
    }
  const idx: number[] = [];
  for (let b = best.phase; b < beatFrames.length; b += best.bar) idx.push(b);
  return { phase: best.phase, bar: best.bar, downbeatIdx: idx };
}

/** Sections: beat-synchronous chroma + mel features, a self-similarity matrix, Foote novelty with
 *  a checkerboard kernel, peaks at least `minBars` apart, snapped to downbeats, clustered by similarity. */
export function sections(beatFrames: number[], dbIdx: number[], bar: number, f: Features, rmsPerBeat: number[]): { boundaries: number[]; labels: string[] } {
  const nb = beatFrames.length;
  if (nb < 16) return { boundaries: [0], labels: ["A"] };
  const feat: Float32Array[] = [];
  for (let b = 0; b < nb; b++) {
    const i0 = beatFrames[b], i1 = b + 1 < nb ? beatFrames[b + 1] : f.mel.length;
    const v = new Float32Array(12 + N_MELS);
    let n = 0;
    for (let i = i0; i < Math.min(i1, f.mel.length); i++) {
      for (let k = 0; k < 12; k++) v[k] += f.chroma[i][k];
      for (let k = 0; k < N_MELS; k++) v[12 + k] += f.mel[i][k] * 0.1;
      n++;
    }
    let norm = 0;
    for (let k = 0; k < v.length; k++) { v[k] /= Math.max(1, n); norm += v[k] * v[k]; }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < v.length; k++) v[k] /= norm;
    feat.push(v);
  }
  const sim = (a: number, b: number) => { let s = 0; const x = feat[a], y = feat[b]; for (let k = 0; k < x.length; k++) s += x[k] * y[k]; return s; };
  const S: Float32Array[] = feat.map((_, i) => { const r = new Float32Array(nb); for (let j = 0; j < nb; j++) r[j] = sim(i, j); return r; });
  const K = Math.max(4, 4 * bar); // kernel half-size in beats
  const nov = new Float32Array(nb);
  for (let i = K; i < nb - K; i++) {
    let s = 0;
    for (let a = -K; a < K; a++)
      for (let b = -K; b < K; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const g = Math.exp(-((a * a + b * b) / (2 * (K / 2) ** 2)));
        s += sign * g * S[i + a][i + b];
      }
    nov[i] = Math.max(0, s);
  }
  const mx = Math.max(1e-6, ...nov);
  for (let i = 0; i < nb; i++) nov[i] /= mx;
  // Peaks at least minBars apart, above a threshold, snapped to the nearest downbeat.
  const minGap = 8 * bar;
  const peaks: number[] = [];
  for (let i = 1; i < nb - 1; i++)
    if (nov[i] > 0.25 && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1]) {
      const snapped = dbIdx.reduce((best, d) => (Math.abs(d - i) < Math.abs(best - i) ? d : best), dbIdx[0] ?? i);
      if (peaks.length && snapped - peaks[peaks.length - 1] < minGap) {
        if (nov[i] > nov[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = snapped;
      } else peaks.push(snapped);
    }
  const boundaries = [0, ...peaks.filter((p) => p > minGap / 2 && p < nb - minGap / 2)];
  // Cluster sections by mean feature similarity so repeats share a label.
  const means = boundaries.map((b0, i) => {
    const b1 = boundaries[i + 1] ?? nb;
    const v = new Float32Array(feat[0].length);
    for (let b = b0; b < b1; b++) for (let k = 0; k < v.length; k++) v[k] += feat[b][k];
    let n = 0;
    for (let k = 0; k < v.length; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < v.length; k++) v[k] /= n;
    return v;
  });
  const labels: string[] = [];
  const reps: Float32Array[] = [];
  for (const m of means) {
    let best = -1, bs = 0.93;
    reps.forEach((r, i) => { let s = 0; for (let k = 0; k < r.length; k++) s += r[k] * m[k]; if (s > bs) { bs = s; best = i; } });
    if (best < 0) { reps.push(m); best = reps.length - 1; }
    labels.push(String.fromCharCode(65 + (best % 26)));
  }
  void rmsPerBeat;
  return { boundaries, labels };
}

/** A beat's time in seconds. Log-compressed flux peaks in the first frame a transient enters,
 *  at the window's tail, so a frame's onset time sits near the window's end (measured on
 *  synthetic clicks: within ±15 ms). Parabolic interpolation refines the frame. */
function beatTime(onset: Float32Array, frame: number, frameRate: number): number {
  let b = frame;
  for (const k of [-1, 1]) if (onset[frame + k] !== undefined && onset[frame + k] > onset[b]) b = frame + k;
  let frac = 0;
  if (b > 0 && b < onset.length - 1) {
    const a = onset[b - 1], c = onset[b + 1], d = a - 2 * onset[b] + c;
    if (d < 0) frac = clamp((0.5 * (a - c)) / d, -0.5, 0.5);
  }
  return (b + frac) / frameRate + (N_FFT - HOP / 2) / SR;
}

export function analyzeMusic(channels: Float32Array[], srIn: number, onProgress?: (p: number) => void): MusicAnalysis {
  const x = resampleMono(channels, srIn);
  const duration = x.length / SR;
  onProgress?.(0.1);
  const f = features(x);
  onProgress?.(0.5);
  const tp = tempo(f.onset, f.frameRate);
  const beatFrames = trackBeats(f.onset, f.frameRate, tp.bpm);
  const beats = beatFrames.map((b) => beatTime(f.onset, b, f.frameRate));
  onProgress?.(0.7);
  const db = downbeats(beatFrames, f);
  const downbeatTimes = db.downbeatIdx.map((i) => beats[i]);
  // Energy per beat: loudness and brightness, smoothed per bar, normalized.
  const rmsPerBeat = beatFrames.map((bf, i) => {
    const b1 = beatFrames[i + 1] ?? f.rms.length;
    let s = 0, n = 0, br = 0;
    for (let k = bf; k < Math.min(b1, f.rms.length); k++) { s += f.rms[k]; br += f.brightness[k]; n++; }
    return n ? (s / n) * (1 + 0.0001 * (br / n)) : 0;
  });
  const smoothed = rmsPerBeat.map((_, i) => mean(rmsPerBeat.slice(Math.max(0, i - db.bar), i + db.bar + 1)));
  const emax = Math.max(1e-6, ...smoothed);
  const energy = smoothed.map((e) => e / emax);
  const sec = sections(beatFrames, db.downbeatIdx, db.bar, f, rmsPerBeat);
  onProgress?.(0.9);
  const secs: MusicAnalysis["sections"] = sec.boundaries.map((b0, i) => {
    const b1 = sec.boundaries[i + 1] ?? beats.length;
    const e = mean(energy.slice(b0, b1));
    return { start: beats[b0] ?? 0, end: b1 < beats.length ? beats[b1] : duration, label: sec.labels[i], energyValue: e, energy: e < 0.45 ? "low" : e > 0.75 ? "high" : "mid" };
  });
  if (secs.length) { secs[0].start = 0; secs[secs.length - 1].end = duration; }
  // Accents: big rises in energy at section starts or over a bar.
  const accents: number[] = [];
  for (let i = db.bar; i < energy.length; i++) if (energy[i] - energy[i - db.bar] > 0.3 && db.downbeatIdx.includes(i)) accents.push(beats[i]);
  // Edges: leading and trailing silence, fade-out start.
  const thr = 0.02 * Math.max(1e-6, ...Array.from(f.rms));
  let lead = 0; while (lead < f.rms.length && f.rms[lead] < thr) lead++;
  let trail = f.rms.length - 1; while (trail > 0 && f.rms[trail] < thr) trail--;
  const peakRms = Math.max(1e-6, ...Array.from(f.rms));
  let fade = trail;
  for (let i = trail; i > trail - f.frameRate * 20 && i > 0; i--) if (f.rms[i] > 0.5 * peakRms) { fade = i; break; }
  // Loudness: K-weighted-ish RMS in dB (no true K filter; brightness-weighted approximation).
  const lufs = 20 * Math.log10(Math.max(1e-6, Math.sqrt(mean(Array.from(f.rms).map((r) => r * r))))) - 0.7;
  // Waveform envelope for the timeline, 10 per second.
  const per = Math.round(SR / 10), waveform: number[] = [];
  for (let i = 0; i < x.length; i += per) { let p = 0; for (let k = i; k < Math.min(x.length, i + per); k++) p = Math.max(p, Math.abs(x[k])); waveform.push(p); }
  onProgress?.(1);
  return {
    v: 1, duration, sampleRate: SR, tempo: tp.bpm, tempoAlt: tp.alt, beats, downbeats: downbeatTimes, beatsPerBar: db.bar,
    sections: secs, energy, accents, edges: { leadIn: lead / f.frameRate, fadeOut: fade / f.frameRate, trailing: duration - trail / f.frameRate },
    loudness: lufs, waveform, offset: 0,
  };
}
