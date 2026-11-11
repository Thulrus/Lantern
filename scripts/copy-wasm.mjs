// Copies the WASM runtimes Lantern loads at runtime into public/ so they are served same-origin
// (spec §11.3: no third-party scripts). Runs before dev and build.
import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
mkdirSync(join(out, "mediapipe"), { recursive: true });
mkdirSync(join(out, "ort"), { recursive: true });
const mp = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
for (const f of readdirSync(mp)) cpSync(join(mp, f), join(out, "mediapipe", f));
const ort = join(root, "node_modules", "onnxruntime-web", "dist");
for (const f of readdirSync(ort)) if (/^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(f)) cpSync(join(ort, f), join(out, "ort", f));
if (!existsSync(join(out, "mediapipe", "vision_wasm_internal.wasm"))) throw new Error("mediapipe wasm not copied");
console.log("vendor wasm copied to public/vendor");
