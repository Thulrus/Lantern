// Face detection with MediaPipe's Face Detector (Apache-2.0), run in a worker. Group photos get a
// second pass over tiles so small faces are found (spec §4.3). Landmarks (5 points) and the
// score come from the model; eyes-open and smile come from the Face Landmarker when available.
import { FaceDetector, FilesetResolver, type Detection } from "@mediapipe/tasks-vision";
import type { Box, FaceResult } from "$lib/planner/types";
import { modelBlobUrl } from "$lib/models/fetch";
import { iou } from "$lib/util/math";

export const FACES_VERSION = 2;
export const FACES_MODEL = "mp-face-short";

let detector: FaceDetector | null = null;
let loading: Promise<FaceDetector> | null = null;

export async function loadFaceDetector(base: string, onProgress?: (done: number, total: number) => void): Promise<FaceDetector> {
  if (detector) return detector;
  loading ??= (async () => {
    const [fileset, modelUrl] = await Promise.all([FilesetResolver.forVisionTasks(base + "vendor/mediapipe"), modelBlobUrl(FACES_MODEL, onProgress)]);
    let d: FaceDetector;
    try {
      d = await FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.4 });
    } catch {
      d = await FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.4 });
    }
    detector = d;
    return d;
  })();
  return loading;
}

export function unloadFaceDetector(): void { detector?.close(); detector = null; loading = null; }

function toResult(d: Detection, ox: number, oy: number, scale: number): FaceResult | null {
  const b = d.boundingBox;
  if (!b) return null;
  const box: Box = [ox + b.originX * scale, oy + b.originY * scale, ox + (b.originX + b.width) * scale, oy + (b.originY + b.height) * scale];
  const landmarks = d.keypoints?.map((k) => [ox + k.x * scale, oy + k.y * scale] as [number, number]);
  return { box, score: d.categories[0]?.score ?? 0, landmarks };
}

/** Detect faces on an image (any size). `scale` maps image pixels back to source pixels. */
export async function detectFaces(det: FaceDetector, img: ImageBitmap | OffscreenCanvas, scale: number): Promise<FaceResult[]> {
  const w = img.width, h = img.height;
  const full = det.detect(img as never).detections.map((d) => toResult(d, 0, 0, scale)).filter((f): f is FaceResult => !!f);
  // Tiled pass for small faces on larger images: 2×2 (and 3×3 on wide groups) with overlap.
  const out = [...full];
  const grids = w >= 640 ? [2] : [];
  if (w >= 1200 && (full.length >= 2 || full.length === 0)) grids.push(3);
  for (const g of grids) {
    const tw = Math.ceil(w / g), th = Math.ceil(h / g), ov = 0.2;
    for (let gy = 0; gy < g; gy++)
      for (let gx = 0; gx < g; gx++) {
        const x0 = Math.max(0, Math.floor(gx * tw - ov * tw)), y0 = Math.max(0, Math.floor(gy * th - ov * th));
        const x1 = Math.min(w, Math.ceil((gx + 1) * tw + ov * tw)), y1 = Math.min(h, Math.ceil((gy + 1) * th + ov * th));
        const c = new OffscreenCanvas(x1 - x0, y1 - y0);
        c.getContext("2d")!.drawImage(img as never, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        for (const d of det.detect(c as never).detections) {
          const f = toResult(d, x0 * scale, y0 * scale, scale);
          if (!f || f.score < 0.5) continue;
          // Keep tile faces that are new; a tile face that overlaps a known one refines nothing.
          if (out.every((o) => iou(o.box, f.box) < 0.3)) out.push(f);
        }
      }
  }
  // Non-maximum suppression and sort by size.
  const kept: FaceResult[] = [];
  for (const f of out.sort((a, b) => b.score - a.score)) if (kept.every((k) => iou(k.box, f.box) < 0.35)) kept.push(f);
  return kept.sort((a, b) => area(b.box) - area(a.box));
}

const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
