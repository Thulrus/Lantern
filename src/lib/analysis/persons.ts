// Person boxes with MediaPipe's Object Detector (EfficientDet-Lite0, Apache-2.0, COCO "person"),
// for the generative fill's person guard (spec §4.6): people touching the hole are kept out of the
// model's context so it cannot extend a cropped body, and a fill that shows a new person is rejected.
import { FilesetResolver, ImageSegmenter, ObjectDetector } from "@mediapipe/tasks-vision";
import type { Box } from "$lib/planner/types";
import { modelBlobUrl } from "$lib/models/fetch";

export const PERSONS_MODEL = "mp-efficientdet-lite0";
export interface PersonBox { box: Box; score: number }

let detector: ObjectDetector | null = null;
let loading: Promise<ObjectDetector> | null = null;

export async function loadPersonDetector(base: string, onProgress?: (done: number, total: number) => void): Promise<ObjectDetector> {
  if (detector) return detector;
  loading ??= (async () => {
    const [fileset, modelUrl] = await Promise.all([FilesetResolver.forVisionTasks(base + "vendor/mediapipe"), modelBlobUrl(PERSONS_MODEL, onProgress)]);
    const opts = (delegate: "GPU" | "CPU") => ({ baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: "IMAGE" as const, scoreThreshold: 0.3, categoryAllowlist: ["person"], maxResults: 20 });
    try { detector = await ObjectDetector.createFromOptions(fileset, opts("GPU")); }
    catch { detector = await ObjectDetector.createFromOptions(fileset, opts("CPU")); }
    return detector;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}

export function unloadPersonDetector(): void { detector?.close(); detector = null; loading = null; }

/** Person boxes on an image; `scale` maps image pixels to the caller's pixels. */
export function detectPersons(det: ObjectDetector, img: ImageBitmap | OffscreenCanvas, scale: number): PersonBox[] {
  return det.detect(img as never).detections.flatMap((d) => {
    const b = d.boundingBox;
    if (!b) return [];
    return [{ box: [b.originX * scale, b.originY * scale, (b.originX + b.width) * scale, (b.originY + b.height) * scale] as Box, score: d.categories[0]?.score ?? 0 }];
  });
}

// Person segmentation with MediaPipe's Image Segmenter (DeepLab v3, Pascal VOC, Apache-2.0):
// a coarse (257² inside the model) person mask so depth mattes keep whole people (spec §4.6).
export const SEGMENT_MODEL = "mp-deeplab-v3";
let segmenter: ImageSegmenter | null = null;
let segLoading: Promise<ImageSegmenter> | null = null;
let personLabel = 15;

export async function loadSegmenter(base: string, onProgress?: (done: number, total: number) => void): Promise<ImageSegmenter> {
  if (segmenter) return segmenter;
  segLoading ??= (async () => {
    const [fileset, modelUrl] = await Promise.all([FilesetResolver.forVisionTasks(base + "vendor/mediapipe"), modelBlobUrl(SEGMENT_MODEL, onProgress)]);
    const opts = (delegate: "GPU" | "CPU") => ({ baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: "IMAGE" as const, outputCategoryMask: true, outputConfidenceMasks: false });
    try { segmenter = await ImageSegmenter.createFromOptions(fileset, opts("GPU")); }
    catch { segmenter = await ImageSegmenter.createFromOptions(fileset, opts("CPU")); }
    const i = segmenter.getLabels().findIndex((l) => l.toLowerCase() === "person");
    if (i >= 0) personLabel = i;
    return segmenter;
  })();
  try { return await segLoading; } catch (e) { segLoading = null; throw e; }
}

export function unloadSegmenter(): void { segmenter?.close(); segmenter = null; segLoading = null; }

/** Person mask (1 = person) at the image's size. */
export function segmentPeople(seg: ImageSegmenter, img: ImageBitmap | OffscreenCanvas): { mask: Uint8Array; w: number; h: number } {
  const r = seg.segment(img as never);
  const m = r.categoryMask!;
  const cat = m.getAsUint8Array(), out = new Uint8Array(cat.length);
  for (let i = 0; i < cat.length; i++) out[i] = cat[i] === personLabel ? 1 : 0;
  const res = { mask: out, w: m.width, h: m.height };
  r.close();
  return res;
}
