# Lantern: development status and handoff

Status as of 2026-11-10 (third session): **a working vertical slice, deployed on GitHub Pages, with music fixed, creative looks removed and the depth stage (M5 start) running.** Import
photos and songs, get an automatically planned 2D show with beat-synced cuts, edit it in the
editor, export an MP4. All of it was exercised end to end in headless Chromium by the Playwright
test (`tests/e2e/show.spec.ts`) against the owner's local `example_photos/` folder. The owner
has committed ("Basics working") and deployed to GitHub Pages.

## Session 3 (2026-11-10): looks removed, depth stage built

**Depth (M5 start).** `src/lib/analysis/depth.ts` runs Depth Anything V2 Small (8-bit ONNX export
from `onnx-community`, 27 MB, SHA-256 pinned in the registry, Apache-2.0) on ONNX Runtime Web's
WASM provider inside the analysis worker (`onnxruntime-web/wasm` is the bundle variant, so no
dynamic import in the classic worker; threads when cross-origin isolated). `ort.env.wasm.wasmPaths` must name only the `.wasm` file (object form): a URL prefix makes ORT `import()` the glue from `/vendor`, which Vite's dev server refuses for `public/` files (seen by the owner, fixed the same session). Verified in dev (module worker) and in the production build (classic worker). Stage `depth` in
`queue.ts` requires basics and faces, skips videos, writes `/m/<hash>/depth.u16.gz` (8-byte
`LDP1` header + u16 samples, see spec §8.1) and stores a `DepthInfo` summary (sep, pivot, quality,
32 × 32 probe grid) in the analysis record. `depthmath.ts` holds the pure parts (unit-tested).
The asset loader uploads the map as the renderer's maps texture (RG = depth, BA = 0: one layer,
no matte yet), the planner gets `depthAt` for border clamping, `compile` bounds use it too, and
`absorbAnalysis` re-plans (or offers the upgrade) when depth lands, so slides go from draft to
full. Measured in headless Chromium (CPU): 1 s session init, 3.3–4.2 s per photo at 770 × 518,
23/23 photos, no errors; e2e `tests/e2e/depth.spec.ts` exercises the bench button and
`show.spec.ts` now picks Cinematic and asserts no depth errors. Workers hold a `resident` set of
model stages so jobs prefer a worker that already has their model loaded. Not done: mattes and
the two-layer mesh, depth wipe / fly-through (still rendered as crossfades), disc DOF, WebGPU
provider, tuning of `quality` (saturates at 1.0 on real photos) and `sep` thresholds on real
photos with a GPU.

**Looks removed.** 
The owner found the creative image looks useless ("we really just want normal pictures"). Removed
in full: the per-slide `look` (Topo, Engraving, Thermal, Hologram shaders and the Inspector
segment), the film grade (grain, vignette, tone curve in the composite pass), the scan-reveal
transition and the Dreamlike preset that existed for them. Style presets now only govern pace,
treatment and transition weights, depth share and beat sync. Spec §1.3 records the decision as a
non-goal; §5.6, §5.7, §5.10, §8, §9.3, §11.2 and §14 were updated. Old projects in IndexedDB may
still carry `look`/`grade` fields on slides or a `styleId` of `dreamlike`; both are ignored
(`styleById` falls back to Classic), no migration needed.

## Session 2 (2026-11-10): the music crash

Adding a song crashed the owner's machine. The song was the local `example_photos/VideoMusic3.mp3`,
a **3-hour, 258 MB** MP3: decoding it produced ~4 GB of PCM on the main thread, a second copy went
to the worker, and the section detector built a beats × beats similarity matrix (~21,000², 1.8 GB).
Fixes, all verified in headless Chromium against that file and a 4-minute excerpt of it:

- `importSong` probes the duration with a media element before decoding and refuses songs over
  `MAX_SONG_SECONDS` (30 min) with a message naming the length (shows as the import toast).
- Analysis decode happens at 22,050 Hz (`decodeForAnalysis`), is downmixed to mono on the main
  thread and transferred to the worker as one array. Playback and export still decode at full rate.
- `src/lib/audio/analyze.ts`: flat typed arrays for mel/chroma, banded self-similarity for Foote
  novelty, no `Math.max(...spread)` (it throws past ~100k frames), finer progress, worker `onerror`
  rejects pending jobs. A 30-minute track: 7 s, +28 MB. Tests cover a 20-minute track and the limit.
- Planner: when the music is more than 1.6× longer than the photos need, the show now ends at a
  section boundary (or downbeat) near the needed length and the music fades out there, instead of
  stretching every slide (8 photos on a 4-minute song used to give 30-second slides). Warning text
  says where it fades. Also fixed the "3:60" clock formatting in mismatch warnings.
- Peak Chromium RSS during the browser run: 1.5 GB (SwiftShader included).

## What exists

| Area | Where | State |
|---|---|---|
| Scaffold | `package.json`, `vite.config.ts`, `.github/workflows/` | Svelte 5 + Vite 8 + TS strict, Vitest, Playwright, Pages deploy workflow (`BASE_PATH` set to the repo name). `scripts/copy-wasm.mjs` copies MediaPipe and ORT runtimes into `public/vendor` before dev/build. |
| Service worker | `public/sw.js` | COOP/COEP injection for cross-origin isolation plus app-shell caching. Registered only in production builds. |
| Data model | `src/lib/planner/types.ts` | Project, Slide, Treatment, Style, analysis results, Timeline (render contract). |
| Camera model | `src/lib/planner/camera.ts` | Ported from Flicker: normalized coords, aim rotation, projection, eased keys, bounds along the track, clamp/fit view. Shared by planner and renderer. |
| Planner | `src/lib/planner/*.ts` | Passes 1–7: curate (pHash complete-linkage groups, quality flags, chapters), order (time/story/manual/shuffle + variety), group (portrait pairs, title cards), durations, music fit (beat-grid DP with locks and mismatch report), treatments (hold/push/pull/pan/sweep/tour laid out and secured for edge + face safety; depth treatments coded but gated on depth data that does not exist yet), transitions, styles as data. `compile()` produces the Timeline. 13 unit tests. |
| Music | `src/lib/audio/` | Own DSP (no AGPL): onset, tempo, Ellis beats, downbeats, Foote sections, energy, edges, loudness, waveform. Worker. Mixer graph shared by preview (AudioContext) and export (OfflineAudioContext). 3 unit tests with synthetic click tracks. |
| Media | `src/lib/media/`, `src/lib/store/` | xxh3 hashing, EXIF (exifr), decode with orientation, proxies to OPFS (IndexedDB fallback), IndexedDB schema per spec §8.1, importer with folder walking and directory handles. |
| Analysis | `src/lib/analysis/` | Basics (pHash, sharpness, exposure, colourfulness, edge density, flags) and spectral-residual saliency at import; MediaPipe faces (tiled) and Depth Anything V2 Small (ORT WASM) in a priority queue with versioned, cached results. |
| Models | `src/lib/models/` | Registry with pinned URL/size/SHA-256/license, checksummed fetch into Cache Storage, Settings page lists and deletes them. |
| Renderer | `src/lib/render/` | WebGL2, pure function of time, mesh + letterbox + composite transitions + captions + beat pulse; asset window loader; preview Player with audio-locked clock. |
| Export | `src/lib/export/export.ts` | OffscreenCanvas + Mediabunny (codec probing, MP4/WebM, save picker or download), offline audio mix, optional 4× motion blur, wake lock in the dialog. MediaRecorder fallback helper exists but is not wired to the UI. |
| UI | `src/app/*.svelte` | Start (drop zone, recents, tier line), Make (style cards, songs, aspect), Editor (preview, storyboard with drag reorder and multi-select, timeline with waveform/beats/sections and duration drag, inspector for slide/show/music, framing editor, library drawer, export dialog, undo/redo, autosave, shortcuts, locks, Try another, Why?), Settings, Bench. |

## Milestones (spec §13)

| # | Milestone | Status |
|---|---|---|
| M0 | Feasibility spikes | Mostly done in-browser (see spec §13.1). Open: deployed-site isolation check, real-song beat accuracy, player compatibility of the MP4, Firefox/Safari matrix, GPU timings. |
| M1 | Import, library, 2D show | Done except CLIP embeddings/tags (story order falls back to time + heuristics) and HEIC. |
| M2 | Music | Done: analysis, fit, several songs with crossfades, mix in preview, basic corrections (tempo alt, grid shift, trims), 30-minute song limit, early fade-out when music outlasts photos. No drag-to-correct sections, no section looping for "music to show", beat accuracy unmeasured on annotated songs. |
| M3 | Editor | Largely done. Missing: project package (.lantern zip) export/import, batch-apply UI beyond multi-select edits, phone layout polish. |
| M4 | Export | Core pipeline done and verified with ffprobe. Missing: golden-frame and A/V sync tests, worker-side rendering (export runs on the main thread with an OffscreenCanvas), WebCodecs frame-accurate video decode (uses `<video>` seeks). |
| M5 | Depth Space | Started: depth stage, maps texture, 3D treatments active when depth and a style with `depthShare > 0` allow. Missing: mattes/two layers, depth transitions, disc DOF, WebGPU provider, threshold tuning. |
| M6 | Fills | Not started. |
| M7 | Video | Partial: videos import, poster thumbnails, clip pick heuristics and ducking envelope exist; no video scan stage, so highlight picking uses the centre of the clip. |
| M8 | Polish | Not started (people clusters, flipbooks, PWA icons, accessibility pass). |

## Decisions so far

- Name: Lantern (owner, 2026-11-10).
- Browser-only, hosted on GitHub Pages (spec §2).
- Face model: MediaPipe Face Detector short range (Apache-2.0); workers are classic (iife) because of its loader; dev server falls back to main-thread faces.
- Beat tracking: own DSP by default (spec §6.2); neural upgrade later.
- Muxing: Mediabunny 1.65 (API verified).
- Test photos live only in the gitignored `example_photos/` (Pixabay, not CC0).
- No creative looks, filters or grades; photos are shown as they are (owner, 2026-11-10).

## Known gaps and rough edges

- The CSP allows `storage.googleapis.com` for the MediaPipe weights until a Hugging Face repo exists (spec §2.1, §15 Q4).
- Export runs on the main thread; a long export blocks the UI. Move the renderer into a worker (OffscreenCanvas transfer) next.
- No CLIP: `story` order uses time plus face heuristics; tags are empty.
- Mattes, plates, person guard: none yet. Depth exists; without a matte the whole photo is one displaced layer, so large 3D amplitudes stretch pixels at depth edges (keep `depthStrength` moderate until mattes land).
- Playwright uses SwiftShader; GPU performance is unmeasured. Chrome headless had no AAC encoder (Opus-in-MP4 was used).
- The `.lantern` project package is not implemented.
- The e2e test skips the picker and uses the download path.

## Next steps

1. Verify cross-origin isolation and model fetches on the deployed Pages site (spec §2.1); the owner reports the deploy works, isolation is unchecked.
2. Measure beat accuracy on real songs (spec §6.2 targets) and GPU render/export speed; record in spec §13.1.
3. M5 Depth Space, continued: look at real 3D moves on a GPU and tune `quality`/`sep` gates and amplitudes; mattes (two-layer mesh), depth wipe and fly-through, disc DOF; try the WebGPU provider with the fp16 export for speed.
4. CLIP ViT-B/32 image tower + build-time tag embeddings (`npm run tags` is declared but the script does not exist yet).
5. Move export rendering into a worker; add golden-frame and A/V sync tests.
6. Project packages, people clusters, flipbooks, video scan stage.
