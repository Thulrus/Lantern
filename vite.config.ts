import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// BASE_PATH is set by the GitHub Pages workflow to "/<repo>/"; locally the app serves from "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [
    svelte(),
    {
      // @mediapipe/tasks-vision ships a sourceMappingURL comment without the map file. Vite reads
      // the map while loading the file (before transforms), so serve the file from a load hook
      // with the comment removed.
      name: "lantern-strip-missing-sourcemaps",
      enforce: "pre",
      async load(id) {
        const file = id.split("?")[0];
        if (!file.includes("@mediapipe/tasks-vision") || !/\.m?js$/.test(file)) return null;
        const code = await readFile(file, "utf8");
        return { code: code.replace(/\/\/# sourceMappingURL=.*$/m, ""), map: null };
      },
    },
  ],
  resolve: { alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) } },
  build: { target: "es2022", sourcemap: true },
  // Classic workers: MediaPipe loads its WASM glue with importScripts, which module workers lack.
  worker: { format: "iife" },
  optimizeDeps: { exclude: ["onnxruntime-web", "@mediapipe/tasks-vision"] },
  server: {
    // Cross-origin isolation in dev (multi-threaded WASM); on Pages the service worker adds these.
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
