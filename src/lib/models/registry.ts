// Every model Lantern can download (spec §4.3, §11.3): pinned URL, size, SHA-256 and license.
// Weights are fetched lazily per feature, verified, and cached in Cache Storage.
export interface ModelSpec {
  id: string;
  task: string;
  name: string;
  url: string;
  bytes: number;
  sha256: string | null;    // null = not yet pinned (trust on first use, recorded in the cache)
  license: string;
  source: string;
  tier: "all" | "standard" | "full";
  note?: string;
}

const GCS = "https://storage.googleapis.com/mediapipe-models";

export const MODELS: ModelSpec[] = [
  {
    id: "mp-face-short", task: "faces", name: "MediaPipe Face Detector (short range)",
    url: `${GCS}/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
    bytes: 229746, sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
    license: "Apache-2.0", source: "https://developers.google.com/mediapipe/solutions/vision/face_detector", tier: "all",
    note: "Faces within about 2 m. Group photos get a tiled second pass for small faces.",
  },
  {
    id: "mp-face-landmarker", task: "faceLandmarks", name: "MediaPipe Face Landmarker (blendshapes)",
    url: `${GCS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    bytes: 3758596, sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    license: "Apache-2.0", source: "https://developers.google.com/mediapipe/solutions/vision/face_landmarker", tier: "standard",
    note: "Eyes-open and smile scores for best-of-burst.",
  },
  {
    id: "depth-anything-v2-small", task: "depth", name: "Depth Anything V2 Small (ONNX)",
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_q4f16.onnx",
    bytes: 0, sha256: null,
    license: "Apache-2.0", source: "https://huggingface.co/onnx-community/depth-anything-v2-small", tier: "all",
    note: "[verify] size and export; Base and Large are CC-BY-NC and must not be used.",
  },
  {
    id: "clip-vit-b32-vision", task: "embedding", name: "CLIP ViT-B/32 image tower (ONNX, quantized)",
    url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx",
    bytes: 0, sha256: null,
    license: "MIT", source: "https://huggingface.co/Xenova/clip-vit-base-patch32", tier: "all",
    note: "[verify] size; zero-shot tags need the text embeddings built at build time.",
  },
];

export const modelById = (id: string) => MODELS.find((m) => m.id === id);
