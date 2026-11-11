// Monocular depth with Depth Anything V2 Small (Apache-2.0) on ONNX Runtime Web, WASM execution
// provider, run in the analysis worker (spec §4.3). The 8-bit dynamically quantised export is
// used on every tier; the input is the photo resized so its short edge is 518 px (392 on lite)
// with both sides multiples of 14, normalised with the ImageNet mean and std (the model card's
// preprocessor config). The output is relative disparity; depthmath turns it into Lantern's maps.
import * as ort from "onnxruntime-web/wasm";
import { fetchModel } from "$lib/models/fetch";

export const DEPTH_VERSION = 1;
export const DEPTH_MODEL = "depth-anything-v2-small";
export const DEPTH_EDGE_FULL = 518, DEPTH_EDGE_LITE = 392;
const MAX_LONG = 826;             // 59 × 14: wide panoramas get a shorter short edge instead
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let session: ort.InferenceSession | null = null;
let loading: Promise<ort.InferenceSession> | null = null;

export async function loadDepth(base: string, onProgress?: (done: number, total: number) => void): Promise<ort.InferenceSession> {
  if (session) return session;
  loading ??= (async () => {
    // Only the .wasm comes from public/vendor: the JS glue is embedded in the "bundle" build we
    // import, and naming a prefix here would make ORT import() the glue from /vendor instead,
    // which Vite's dev server refuses for files in public/.
    ort.env.wasm.wasmPaths = { wasm: base + "vendor/ort/ort-wasm-simd-threaded.wasm" };
    const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
    ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.proxy = false;
    const buf = await fetchModel(DEPTH_MODEL, onProgress);
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    try {
      session = await ort.InferenceSession.create(new Uint8Array(buf), opts);
    } catch (e) {
      if (ort.env.wasm.numThreads === 1) throw e;
      ort.env.wasm.numThreads = 1;                       // threads refused (no isolation, old browser): single thread
      session = await ort.InferenceSession.create(new Uint8Array(buf), opts);
    }
    return session;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}

export async function unloadDepth(): Promise<void> { await session?.release(); session = null; loading = null; }

/** Model input size for an image: short edge ≈ `edge`, both sides multiples of 14. */
export function depthInputSize(w: number, h: number, edge: number): { w: number; h: number } {
  let s = edge / Math.min(w, h);
  if (Math.max(w, h) * s > MAX_LONG) s = MAX_LONG / Math.max(w, h);
  const r = (v: number) => Math.max(14, Math.round((v * s) / 14) * 14);
  return { w: r(w), h: r(h) };
}

/** Raw relative disparity for an image (bigger = nearer), at the model's working size. */
export async function estimateDepth(s: ort.InferenceSession, img: ImageBitmap | OffscreenCanvas, edge: number): Promise<{ raw: Float32Array; w: number; h: number }> {
  const { w, h } = depthInputSize(img.width, img.height, edge);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h, data = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    data[i] = (px[j] / 255 - MEAN[0]) / STD[0];
    data[n + i] = (px[j + 1] / 255 - MEAN[1]) / STD[1];
    data[2 * n + i] = (px[j + 2] / 255 - MEAN[2]) / STD[2];
  }
  const input = new ort.Tensor("float32", data, [1, 3, h, w]);
  const out = await s.run({ [s.inputNames[0]]: input });
  const t = out[s.outputNames[0]];
  const dims = t.dims, oh = dims[dims.length - 2], ow = dims[dims.length - 1];
  const raw = t.data as Float32Array;
  if (ow === w && oh === h) return { raw: Float32Array.from(raw), w, h };
  // Some exports return the input size, others a fixed grid: resample to the input size.
  const res = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) res[y * w + x] = raw[Math.min(oh - 1, Math.floor((y * oh) / h)) * ow + Math.min(ow - 1, Math.floor((x * ow) / w))];
  return { raw: res, w, h };
}
