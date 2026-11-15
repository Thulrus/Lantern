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
    id: "depth-anything-v2-small", task: "depth", name: "Depth Anything V2 Small (ONNX, 8-bit)",
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx",
    bytes: 27258801, sha256: "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d",
    license: "Apache-2.0", source: "https://huggingface.co/onnx-community/depth-anything-v2-small", tier: "all",
    note: "Relative depth for 3D moves. Base and Large are CC-BY-NC and must not be used.",
  },
  {
    id: "mp-efficientdet-lite0", task: "persons", name: "MediaPipe Object Detector (EfficientDet-Lite0)",
    url: `${GCS}/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
    bytes: 7254339, sha256: "4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993",
    license: "Apache-2.0", source: "https://developers.google.com/mediapipe/solutions/vision/object_detector", tier: "all",
    note: "Person boxes for the generative fill's person guard.",
  },
  {
    id: "mp-deeplab-v3", task: "segmentation", name: "MediaPipe Image Segmenter (DeepLab v3)",
    url: `${GCS}/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite`,
    bytes: 2780176, sha256: "ff36e24d40547fe9e645e2f4e8745d1876d6e38b332d39a82f0bf0f5d1d561b3",
    license: "Apache-2.0", source: "https://developers.google.com/mediapipe/solutions/vision/image_segmenter", tier: "all",
    note: "Coarse person mask so depth mattes keep whole people.",
  },
  {
    id: "lama-512", task: "inpaint", name: "LaMa big (ONNX, fp16-stored weights, 512 × 512)",
    url: "https://huggingface.co/HiggityPiggity/lama-onnx-fp16/resolve/feb119a90ac45e7648aa5976559d481a5e9a4a48/lama_fp16w.onnx",
    bytes: 106291403, sha256: "e631637d760e3fa708c059ebc304c66a4867f00ad0891cf4fc0849966a42ecab",
    license: "Apache-2.0", source: "https://huggingface.co/HiggityPiggity/lama-onnx-fp16", tier: "all",
    note: "Generative background fill behind people (opt-in). Carve/LaMa-ONNX lama_fp32.onnx with weights stored as fp16 and cast to fp32 at load (owner's repo; mean error 0.56/255). MI-GAN (MIT) was rejected: figure-like blobs in person-sized holes; 8-bit LaMa is unusable.",
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
