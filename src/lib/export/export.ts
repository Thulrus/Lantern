// Export (spec §10): render every frame at exactly n / fps on an OffscreenCanvas through the
// same renderer as the preview, encode with WebCodecs via Mediabunny, mix the audio offline,
// and mux to MP4 (or WebM when the MP4 codecs are missing), streaming to a file picker where
// available and to a download otherwise.
import { BufferTarget, CanvasSource, AudioBufferSource, Mp4OutputFormat, WebMOutputFormat, Output, StreamTarget, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, canEncodeAudio, canEncodeVideo, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, type VideoCodec, type AudioCodec } from "mediabunny";
import { renderMix } from "$lib/audio/mixer";
import type { Timeline } from "$lib/planner/types";
import { getFile } from "$lib/store/opfs";
import { originalsDb } from "$lib/store/db";
import { decodePhoto } from "$lib/media/decode";
import { Renderer } from "$lib/render/renderer";
import { decodeAudio } from "$lib/media/import";

export interface ExportOptions {
  quality: "standard" | "high" | "max";
  motionBlur: boolean;
  fileName: string;
  container?: "mp4" | "webm";
  useOriginals?: boolean;
  saveTo?: "picker" | "download";
}

export interface ExportProgress { frame: number; frames: number; stage: "prepare" | "audio" | "video" | "finish" | "done"; eta: number; codec: string }

export interface ExportCapabilities { webcodecs: boolean; video: { codec: VideoCodec; container: "mp4" | "webm" } | null; audio: AudioCodec | null; savePicker: boolean }

export async function exportCapabilities(width = 1920, height = 1080): Promise<ExportCapabilities> {
  const webcodecs = typeof VideoEncoder !== "undefined";
  if (!webcodecs) return { webcodecs: false, video: null, audio: null, savePicker: "showSaveFilePicker" in window };
  const mp4Video = await getFirstEncodableVideoCodec(["avc", "hevc", "av1"], { width, height });
  const mp4Audio = await getFirstEncodableAudioCodec(["aac", "opus"]);
  if (mp4Video) return { webcodecs, video: { codec: mp4Video, container: "mp4" }, audio: mp4Audio, savePicker: "showSaveFilePicker" in window };
  const webmVideo = await getFirstEncodableVideoCodec(["vp9", "av1", "vp8"], { width, height });
  const webmAudio = await getFirstEncodableAudioCodec(["opus"]);
  return { webcodecs, video: webmVideo ? { codec: webmVideo, container: "webm" } : null, audio: webmAudio, savePicker: "showSaveFilePicker" in window };
}

async function loadImage(hash: string, originals: boolean): Promise<ImageBitmap | null> {
  const blob = (originals ? await originalsDb.get(hash) : null) ?? (await getFile(hash, "proxy.webp")) ?? (await originalsDb.get(hash));
  if (!blob) return null;
  try { return await decodePhoto(blob); } catch { return null; }
}

/** Frame-accurate video decode for clips through a <video> element seek (WebCodecs decode is a later step). */
class ClipFrames {
  private v: HTMLVideoElement | null = null;
  constructor(private hash: string) {}
  async open(): Promise<boolean> {
    const blob = await originalsDb.get(this.hash);
    if (!blob) return false;
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(blob);
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("video")); });
    this.v = v;
    return true;
  }
  async frameAt(t: number): Promise<HTMLVideoElement | null> {
    const v = this.v;
    if (!v) return null;
    if (Math.abs(v.currentTime - t) > 1 / 120) {
      v.currentTime = t;
      await new Promise<void>((res) => { const done = () => { v.removeEventListener("seeked", done); res(); }; v.addEventListener("seeked", done); setTimeout(done, 1500); });
    }
    return v;
  }
  close(): void { if (this.v) { URL.revokeObjectURL(this.v.src); this.v = null; } }
}

export async function exportVideo(tl: Timeline, opts: ExportOptions, onProgress: (p: ExportProgress) => void, signal?: AbortSignal): Promise<{ fileName: string; bytes: number; codec: string; container: string }> {
  const [W, H] = tl.size;
  const fps = tl.fps;
  const frames = Math.max(1, Math.round(tl.dur * fps));
  const caps = await exportCapabilities(W, H);
  if (!caps.webcodecs || !caps.video) throw new Error("This browser cannot encode video (WebCodecs is missing). Try a recent Chrome or Edge.");
  const container = opts.container ?? caps.video.container;
  const videoCodec: VideoCodec = container === "mp4" ? (await getFirstEncodableVideoCodec(["avc", "hevc", "av1"], { width: W, height: H }))! : (await getFirstEncodableVideoCodec(["vp9", "av1", "vp8"], { width: W, height: H }))!;
  const audioCodec: AudioCodec | null = container === "mp4" ? await getFirstEncodableAudioCodec(["aac", "opus"]) : await getFirstEncodableAudioCodec(["opus"]);
  const codecLabel = `${videoCodec}${audioCodec ? " + " + audioCodec : " (no audio)"}`;
  onProgress({ frame: 0, frames, stage: "prepare", eta: 0, codec: codecLabel });

  // Output target: a save picker's writable stream in Chromium, else an in-memory buffer.
  let writable: FileSystemWritableFileStream | null = null;
  let handle: FileSystemFileHandle | null = null;
  const ext = container === "mp4" ? ".mp4" : ".webm";
  const fileName = opts.fileName.replace(/\.(mp4|webm)$/i, "") + ext;
  if ("showSaveFilePicker" in window && opts.saveTo !== "download") {
    try {
      handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({ suggestedName: fileName, types: [{ description: container === "mp4" ? "MP4 video" : "WebM video", accept: { [container === "mp4" ? "video/mp4" : "video/webm"]: [ext] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("cancelled");
      writable = null;
    }
  }
  const target = writable ? new StreamTarget(writable as unknown as WritableStream, { chunked: true }) : new BufferTarget();
  const format = container === "mp4" ? new Mp4OutputFormat({ fastStart: writable ? "fragmented" : "in-memory" }) : new WebMOutputFormat();
  const output = new Output({ format, target });
  const quality = opts.quality === "max" ? QUALITY_VERY_HIGH : opts.quality === "high" ? QUALITY_HIGH : QUALITY_MEDIUM;

  const canvas = new OffscreenCanvas(W, H);
  const renderer = new Renderer(canvas, { preserve: true });
  // With motion blur, sub-frames are averaged into a 2D canvas and that canvas is encoded.
  const accum = opts.motionBlur ? new OffscreenCanvas(W, H) : null;
  const actx = accum?.getContext("2d", { alpha: false }) ?? null;
  const videoSource = new CanvasSource(accum ?? canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });

  // Audio: mix offline first (it is quick), then feed as one buffer.
  let audioSource: AudioBufferSource | null = null;
  let mix: AudioBuffer | null = null;
  if (audioCodec && tl.audio.length) {
    onProgress({ frame: 0, frames, stage: "audio", eta: 0, codec: codecLabel });
    const buffers = new Map<string, AudioBuffer>();
    for (const src of new Set(tl.audio.map((e) => e.src))) {
      const blob = await originalsDb.get(src);
      if (blob) buffers.set(src, await decodeAudio(blob));
    }
    mix = await renderMix(tl, buffers, 48000);
    audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  if (audioSource && mix) await audioSource.add(mix);

  // Preload every image once (export is sequential, so load per slide as it comes).
  const loaded = new Map<string, boolean>();
  const clips = new Map<string, ClipFrames>();
  const ensure = async (t: number) => {
    const act = Renderer.activeLayers(tl, t);
    const want = act.flatMap((l) => (l.cells ? l.cells.map((c) => c.slide) : [l]));
    for (const l of want) {
      const h = l.assets.image?.hash;
      if (h && !loaded.has(h)) {
        const bmp = await loadImage(h, !!opts.useOriginals);
        if (bmp) { renderer.upload(h, bmp, true); bmp.close(); }
        loaded.set(h, !!bmp);
      }
      const vh = l.assets.video?.hash;
      if (vh) {
        let c = clips.get(vh);
        if (!c) { c = new ClipFrames(vh); await c.open(); clips.set(vh, c); }
        const local = (l.clip?.in ?? 0) + Math.max(0, t - l.t0) * (l.clip?.speed ?? 1);
        const v = await c.frameAt(local);
        if (v) renderer.upload("v:" + vh, v, false);
      }
    }
    // Free textures of slides well behind the playhead.
    for (const k of renderer.keys()) if (!want.some((l) => l.assets.image?.hash === k || "v:" + l.assets.video?.hash === k) && !k.startsWith("maps:")) { renderer.drop(k); loaded.delete(k); }
  };

  const started = performance.now();
  const sub = opts.motionBlur ? 4 : 1;
  try {
    for (let n = 0; n < frames; n++) {
      if (signal?.aborted) throw new Error("cancelled");
      const t = n / fps;
      if (sub === 1) {
        await ensure(t);
        renderer.draw(tl, t);
      } else {
        for (let s = 0; s < sub; s++) {
          const ts = t + (s / sub) / fps;
          await ensure(ts);
          renderer.draw(tl, ts);
          actx!.globalAlpha = 1 / (s + 1); // running average of the sub-frames
          actx!.drawImage(canvas, 0, 0);
        }
      }
      await videoSource.add(t, 1 / fps);
      if (n % 5 === 0 || n === frames - 1) {
        const elapsed = (performance.now() - started) / 1000;
        onProgress({ frame: n + 1, frames, stage: "video", eta: (elapsed / (n + 1)) * (frames - n - 1), codec: codecLabel });
      }
    }
    onProgress({ frame: frames, frames, stage: "finish", eta: 0, codec: codecLabel });
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    if (writable) await writable.abort().catch(() => {});
    throw e;
  } finally {
    for (const c of clips.values()) c.close();
    renderer.dispose();
  }
  let bytes = 0;
  if (target instanceof BufferTarget) {
    const buf = target.buffer!;
    bytes = buf.byteLength;
    const blob = new Blob([buf], { type: output.format.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else if (handle) {
    bytes = (await handle.getFile()).size;
  }
  onProgress({ frame: frames, frames, stage: "done", eta: 0, codec: codecLabel });
  return { fileName, bytes, codec: codecLabel, container };
}

/** Fallback export: real-time capture from the preview canvas with MediaRecorder. */
export async function exportRealtime(canvas: HTMLCanvasElement, play: () => Promise<void>, durationSec: number, fileName: string): Promise<Blob> {
  const stream = canvas.captureStream(30);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType })); });
  rec.start(500);
  await play();
  await new Promise((r) => setTimeout(r, durationSec * 1000 + 500));
  rec.stop();
  const blob = await done;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = fileName.replace(/\.[^.]+$/, "") + ".webm"; a.click();
  return blob;
}

export const canWebCodecs = () => typeof VideoEncoder !== "undefined";
export { canEncodeAudio, canEncodeVideo };
