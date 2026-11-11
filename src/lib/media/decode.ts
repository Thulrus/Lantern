// Photo decoding with EXIF orientation applied, plus proxies and thumbnails (spec §4.1).
import exifr from "exifr";

export const PROXY_EDGE = 2560, THUMB_EDGE = 320, ANALYSIS_EDGE = 1024;

export interface Exif { taken?: number; gps?: [number, number]; camera?: string; orientation?: number }

export async function readExif(file: Blob): Promise<Exif> {
  try {
    const x = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate", "Orientation", "Make", "Model", "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef"], gps: true } as never) as Record<string, unknown> | undefined;
    if (!x) return {};
    const d = (x.DateTimeOriginal ?? x.CreateDate) as Date | string | undefined;
    const taken = d instanceof Date ? d.getTime() : typeof d === "string" ? Date.parse(d) : undefined;
    const lat = x.latitude as number | undefined, lon = x.longitude as number | undefined;
    return {
      taken: taken && Number.isFinite(taken) ? taken : undefined,
      gps: typeof lat === "number" && typeof lon === "number" ? [lat, lon] : undefined,
      camera: [x.Make, x.Model].filter(Boolean).join(" ") || undefined,
      orientation: typeof x.Orientation === "number" ? x.Orientation : undefined,
    };
  } catch {
    return {};
  }
}

const HEIC = /\.(heic|heif)$/i;

/** Decode a photo to an ImageBitmap with EXIF orientation applied (browsers honour it with
 *  `imageOrientation: "from-image"`). HEIC falls back to a lazily loaded WASM decoder later. */
export async function decodePhoto(file: Blob & { name?: string }): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    if (file.name && HEIC.test(file.name)) throw new Error("HEIC is not supported by this browser yet");
    throw e;
  }
}

/** Resize to a long edge, returning an ImageBitmap (GPU-friendly) via OffscreenCanvas. */
export function resizeBitmap(src: ImageBitmap, longEdge: number): { canvas: OffscreenCanvas; w: number; h: number } {
  const k = Math.min(1, longEdge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return { canvas: c, w, h };
}

export async function encodeWebp(canvas: OffscreenCanvas, quality = 0.85): Promise<Blob> {
  try {
    return await canvas.convertToBlob({ type: "image/webp", quality });
  } catch {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
}

export function greyData(canvas: OffscreenCanvas): { data: Uint8ClampedArray; w: number; h: number; grey: Float32Array } {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grey = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) grey[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  return { data: img.data, w: img.width, h: img.height, grey };
}

/** Video metadata and a poster frame via a <video> element. */
export async function probeVideo(file: Blob): Promise<{ w: number; h: number; duration: number; poster: ImageBitmap | null; decodable: boolean }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  try {
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error("cannot decode this video")); });
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(1, duration / 3);
    await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 3000); });
    let poster: ImageBitmap | null = null;
    try { poster = await createImageBitmap(v); } catch { poster = null; }
    return { w: v.videoWidth, h: v.videoHeight, duration, poster, decodable: v.videoWidth > 0 };
  } catch {
    return { w: 0, h: 0, duration: 0, poster: null, decodable: false };
  } finally {
    v.src = ""; URL.revokeObjectURL(url);
  }
}
