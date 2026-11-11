// Import (spec §4.1): files and folders in, media records and derived files out. Photos are
// hashed, decoded with EXIF orientation, proxied into OPFS and given their basics right away.
// Songs are decoded and analysed. Nothing leaves the device.
import type { AnalysisQueue } from "$lib/analysis/queue";
import { hashFile } from "./hash";
import { decodePhoto, probeVideo, readExif, resizeBitmap, encodeWebp, THUMB_EDGE } from "./decode";
import { mediaDb, originalsDb, songsDb, type MediaRecord } from "$lib/store/db";
import { putFile } from "$lib/store/opfs";
import type { MediaInfo, MusicAnalysis, SongInfo } from "$lib/planner/types";
import { MAX_SONG_SECONDS, SR as ANALYSIS_SR } from "$lib/audio/analyze";
import MusicWorker from "../../workers/music.worker?worker";

export const PHOTO_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|bmp)$/i;
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga|weba)$/i;

export type ImportKind = "photo" | "video" | "song" | "other";
export const kindOf = (name: string, type = ""): ImportKind =>
  PHOTO_EXT.test(name) || type.startsWith("image/") ? "photo" : VIDEO_EXT.test(name) || type.startsWith("video/") ? "video" : AUDIO_EXT.test(name) || type.startsWith("audio/") ? "song" : "other";

export interface ImportProgress { done: number; total: number; current: string; errors: { name: string; error: string }[] }

/** Walk dropped items (files and directories) into a flat list of files with handles where available. */
export async function collectFiles(items: DataTransferItemList | FileList | File[]): Promise<{ file: File; handle?: FileSystemFileHandle }[]> {
  const out: { file: File; handle?: FileSystemFileHandle }[] = [];
  if (items instanceof FileList || Array.isArray(items)) { for (const f of Array.from(items)) out.push({ file: f }); return out; }
  const entries: FileSystemEntry[] = [], handles: Promise<FileSystemHandle | null>[] = [];
  for (const it of Array.from(items)) {
    if (it.kind !== "file") continue;
    const e = it.webkitGetAsEntry?.();
    if (e) entries.push(e);
    const h = (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.();
    handles.push(h ?? Promise.resolve(null));
  }
  const hs = await Promise.all(handles);
  for (let i = 0; i < entries.length; i++) await walkEntry(entries[i], hs[i], out);
  return out;
}

async function walkEntry(e: FileSystemEntry, handle: FileSystemHandle | null, out: { file: File; handle?: FileSystemFileHandle }[]): Promise<void> {
  if (e.isFile) {
    const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
    out.push({ file: f, handle: handle?.kind === "file" ? (handle as FileSystemFileHandle) : undefined });
  } else if (e.isDirectory) {
    if (handle?.kind === "directory") { await walkDirHandle(handle as FileSystemDirectoryHandle, out); return; }
    const r = (e as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));
      if (!batch.length) break;
      for (const c of batch) await walkEntry(c, null, out);
    }
  }
}

export async function walkDirHandle(dir: FileSystemDirectoryHandle, out: { file: File; handle?: FileSystemFileHandle }[]): Promise<void> {
  for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith(".")) continue;
    if (h.kind === "file") out.push({ file: await (h as FileSystemFileHandle).getFile(), handle: h as FileSystemFileHandle });
    else await walkDirHandle(h as FileSystemDirectoryHandle, out);
  }
}

export interface Imported { media: string[]; songs: string[]; errors: { name: string; error: string }[] }

export async function importFiles(files: { file: File; handle?: FileSystemFileHandle }[], queue: AnalysisQueue, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<Imported> {
  const prog: ImportProgress = { done: 0, total: files.length, current: "", errors: [] };
  const media: string[] = [], songs: string[] = [];
  // Photos import in parallel (bounded), since hashing and decoding are the slow parts.
  const PAR = 3;
  let next = 0;
  const workers = Array.from({ length: PAR }, async () => {
    while (next < files.length && !signal?.aborted) {
      const { file, handle } = files[next++];
      prog.current = file.name;
      onProgress({ ...prog });
      try {
        const kind = kindOf(file.name, file.type);
        if (kind === "photo") media.push(await importPhoto(file, handle, queue));
        else if (kind === "video") media.push(await importVideo(file, handle));
        else if (kind === "song") songs.push(await importSong(file, handle));
      } catch (e) {
        prog.errors.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
      }
      prog.done++;
      onProgress({ ...prog });
    }
  });
  await Promise.all(workers);
  queue.enqueue(media);
  return { media, songs, errors: prog.errors };
}

const dedupe = <T,>(xs: T[]) => Array.from(new Set(xs));
void dedupe;

async function importPhoto(file: File, handle: FileSystemFileHandle | undefined, queue: AnalysisQueue): Promise<string> {
  const hash = await hashFile(file);
  const existing = await mediaDb.get(hash);
  if (existing) {
    if (handle && !existing.handle) { existing.handle = handle; await mediaDb.put(existing); }
    return hash;
  }
  const [exif, bmp] = await Promise.all([readExif(file), decodePhoto(file)]);
  const info: MediaInfo = { hash, kind: "photo", name: file.name, w: bmp.width, h: bmp.height, taken: exif.taken ?? (file.lastModified || undefined), gps: exif.gps, bytes: file.size };
  const rec: MediaRecord = { info, handle, flags: [], added: Date.now(), hasOriginal: !!handle };
  await mediaDb.put(rec);
  if (!handle) await originalsDb.put(hash, file); // no directory handle: keep the original so export and relinking work
  await queue.importBasics(hash, bmp, info.w, info.h, file.name);
  return hash;
}

async function importVideo(file: File, handle: FileSystemFileHandle | undefined): Promise<string> {
  const hash = await hashFile(file);
  if (await mediaDb.get(hash)) return hash;
  const p = await probeVideo(file);
  if (!p.decodable) throw new Error("this browser cannot decode this video");
  const exif = await readExif(file).catch(() => ({} as { taken?: number }));
  const info: MediaInfo = { hash, kind: "video", name: file.name, w: p.w, h: p.h, duration: p.duration, taken: exif.taken ?? (file.lastModified || undefined), bytes: file.size };
  await mediaDb.put({ info, handle, flags: [], added: Date.now(), hasOriginal: true });
  await originalsDb.put(hash, file);
  if (p.poster) {
    const t = resizeBitmap(p.poster, THUMB_EDGE);
    await putFile(hash, "thumb.webp", await encodeWebp(t.canvas, 0.8));
    const a = resizeBitmap(p.poster, 1024);
    await putFile(hash, "analysis.webp", await encodeWebp(a.canvas, 0.85));
    await putFile(hash, "proxy.webp", await encodeWebp(a.canvas, 0.85));
    p.poster.close();
  }
  return hash;
}

let musicWorker: Worker | null = null;
let musicJob = 0;
const musicWaiting = new Map<number, { resolve: (a: MusicAnalysis) => void; reject: (e: Error) => void; progress?: (p: number) => void }>();

/** Analyse one mono channel in the worker. The array is transferred, not copied. */
export function analyzeSongSamples(mono: Float32Array, sampleRate: number, progress?: (p: number) => void): Promise<MusicAnalysis> {
  musicWorker ??= (() => {
    const w = new MusicWorker();
    w.onmessage = (e: MessageEvent<{ id: number; result?: MusicAnalysis; error?: string; progress?: number }>) => {
      const p = musicWaiting.get(e.data.id);
      if (!p) return;
      if (e.data.progress !== undefined) { p.progress?.(e.data.progress); return; }
      musicWaiting.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result!);
    };
    w.onerror = (e) => {
      // The worker itself failed (bad bundle, out of memory): fail every pending job.
      for (const [id, p] of musicWaiting) { musicWaiting.delete(id); p.reject(new Error(e.message || "music analysis failed")); }
      musicWorker = null;
    };
    return w;
  })();
  const id = ++musicJob;
  return new Promise((resolve, reject) => {
    musicWaiting.set(id, { resolve, reject, progress });
    musicWorker!.postMessage({ id, channels: [mono], sampleRate }, [mono.buffer]);
  });
}

export function analyzeSongBuffer(buf: AudioBuffer, progress?: (p: number) => void): Promise<MusicAnalysis> {
  return analyzeSongSamples(downmix(buf), buf.sampleRate, progress);
}

/** Average the first two channels into one new array (safe to transfer). */
export function downmix(buf: AudioBuffer): Float32Array {
  const n = buf.length, ch = Math.min(2, buf.numberOfChannels);
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  return mono;
}

/** The song's length without decoding it: a media element reads only the headers. Resolves to
 *  NaN when the browser can't tell (then the decode's own duration is checked instead). */
export function probeAudioDuration(blob: Blob, timeoutMs = 8000): Promise<number> {
  if (typeof document === "undefined") return Promise.resolve(NaN);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement("audio");
    el.preload = "metadata";
    let done = false;
    const finish = (d: number) => { if (done) return; done = true; clearTimeout(timer); el.removeAttribute("src"); el.load(); URL.revokeObjectURL(url); resolve(d); };
    const timer = setTimeout(() => finish(NaN), timeoutMs);
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : NaN);
    el.onerror = () => finish(NaN);
    el.src = url;
  });
}

const fmtLong = (s: number) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const tooLong = (d: number) => new Error(`Songs longer than ${MAX_SONG_SECONDS / 60} minutes are not supported (this one is ${fmtLong(d)}). Trim it first.`);

/** Decode for playback and export, at the file's own sample rate (or the platform default). */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(await blob.arrayBuffer());
}

/** Decode for analysis: the browser resamples to 22,050 Hz while decoding, which holds a
 *  quarter of the memory of a 48 kHz decode and gives a better resampler than ours. Falls back
 *  to the default rate where a context can't be made at 22,050 Hz. */
export async function decodeForAnalysis(blob: Blob): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  let ctx: OfflineAudioContext;
  try { ctx = new OfflineAudioContext(1, 1, ANALYSIS_SR); } catch { ctx = new OfflineAudioContext(1, 1, 44100); }
  return ctx.decodeAudioData(bytes);
}

export async function importSong(file: File, handle?: FileSystemFileHandle, onProgress?: (p: number) => void): Promise<string> {
  const hash = await hashFile(file);
  const existing = await songsDb.get(hash);
  if (existing?.analysis) return hash;
  // Refuse very long files before touching their samples: a 3-hour mix decodes to gigabytes.
  const probed = await probeAudioDuration(file);
  if (probed > MAX_SONG_SECONDS) throw tooLong(probed);
  let buf: AudioBuffer | null = await decodeForAnalysis(file);
  if (buf.duration > MAX_SONG_SECONDS) throw tooLong(buf.duration);
  const info: SongInfo = { hash, name: file.name.replace(/\.[^.]+$/, ""), duration: buf.duration, bytes: file.size };
  const mono = downmix(buf), sampleRate = buf.sampleRate;
  buf = null; // let the decoded channels go before the analysis runs
  await originalsDb.put(hash, file);
  await songsDb.put({ info, handle });
  const analysis = await analyzeSongSamples(mono, sampleRate, onProgress);
  await songsDb.put({ info, handle, analysis });
  return hash;
}
