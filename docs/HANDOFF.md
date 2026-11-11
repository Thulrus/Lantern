# Lantern: development status and handoff

Status as of 2026-11-10 (end of the first build session): **a working vertical slice.** Import
photos and songs, get an automatically planned 2D show with beat-synced cuts, edit it in the
editor, export an MP4. All of it was exercised end to end in headless Chromium by the Playwright
test (`tests/e2e/show.spec.ts`) against the owner's local `example_photos/` folder. Nothing is
deployed yet and nothing has been committed (the owner commits).

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
| Analysis | `src/lib/analysis/` | Basics (pHash, sharpness, exposure, colourfulness, edge density, flags) and spectral-residual saliency at import; MediaPipe faces (tiled) in a priority queue with versioned, cached results. |
| Models | `src/lib/models/` | Registry with pinned URL/size/SHA-256/license, checksummed fetch into Cache Storage, Settings page lists and deletes them. |
| Renderer | `src/lib/render/` | WebGL2, pure function of time, mesh + letterbox + composite transitions + captions + film grade + beat pulse; asset window loader; preview Player with audio-locked clock. |
| Export | `src/lib/export/export.ts` | OffscreenCanvas + Mediabunny (codec probing, MP4/WebM, save picker or download), offline audio mix, optional 4× motion blur, wake lock in the dialog. MediaRecorder fallback helper exists but is not wired to the UI. |
| UI | `src/app/*.svelte` | Start (drop zone, recents, tier line), Make (style cards, songs, aspect), Editor (preview, storyboard with drag reorder and multi-select, timeline with waveform/beats/sections and duration drag, inspector for slide/show/music, framing editor, library drawer, export dialog, undo/redo, autosave, shortcuts, locks, Try another, Why?), Settings, Bench. |

## Milestones (spec §13)

| # | Milestone | Status |
|---|---|---|
| M0 | Feasibility spikes | Mostly done in-browser (see spec §13.1). Open: deployed-site isolation check, real-song beat accuracy, player compatibility of the MP4, Firefox/Safari matrix, GPU timings. |
| M1 | Import, library, 2D show | Done except CLIP embeddings/tags (story order falls back to time + heuristics) and HEIC. |
| M2 | Music | Done: analysis, fit, several songs with crossfades, mix in preview, basic corrections (tempo alt, grid shift, trims). No drag-to-correct sections yet. |
| M3 | Editor | Largely done. Missing: project package (.lantern zip) export/import, batch-apply UI beyond multi-select edits, phone layout polish. |
| M4 | Export | Core pipeline done and verified with ffprobe. Missing: golden-frame and A/V sync tests, worker-side rendering (export runs on the main thread with an OffscreenCanvas), WebCodecs frame-accurate video decode (uses `<video>` seeks). |
| M5 | Depth Space | Not started (renderer and planner already carry the depth path; the Depth stage, maps upload and 3D treatments activation are missing). |
| M6 | Fills | Not started. |
| M7 | Video | Partial: videos import, poster thumbnails, clip pick heuristics and ducking envelope exist; no video scan stage, so highlight picking uses the centre of the clip. |
| M8 | Polish | Not started (people clusters, flipbooks, creative looks only partially, PWA icons, accessibility pass). |

## Decisions so far

- Name: Lantern (owner, 2026-11-10).
- Browser-only, hosted on GitHub Pages (spec §2).
- Face model: MediaPipe Face Detector short range (Apache-2.0); workers are classic (iife) because of its loader; dev server falls back to main-thread faces.
- Beat tracking: own DSP by default (spec §6.2); neural upgrade later.
- Muxing: Mediabunny 1.65 (API verified).
- Test photos live only in the gitignored `example_photos/` (Pixabay, not CC0).

## Known gaps and rough edges

- The CSP allows `storage.googleapis.com` for the MediaPipe weights until a Hugging Face repo exists (spec §2.1, §15 Q4).
- Export runs on the main thread; a long export blocks the UI. Move the renderer into a worker (OffscreenCanvas transfer) next.
- No CLIP: `story` order uses time plus face heuristics; tags are empty.
- Depth, mattes, plates, person guard: none yet, so every slide is "draft" and 2D.
- Playwright uses SwiftShader; GPU performance is unmeasured. Chrome headless had no AAC encoder (Opus-in-MP4 was used).
- The `.lantern` project package is not implemented.
- The e2e test skips the picker and uses the download path.

## Next steps

1. Push to GitHub, enable Pages, and verify cross-origin isolation and model fetches on the deployed site (spec §2.1).
2. Measure beat accuracy on real songs (spec §6.2 targets) and GPU render/export speed; record in spec §13.1.
3. M5 Depth Space: Depth Anything V2 Small on ONNX Runtime Web (registry entry exists, checksum not pinned), maps textures, enable depth treatments and depth transitions.
4. CLIP ViT-B/32 image tower + build-time tag embeddings (`npm run tags` is declared but the script does not exist yet).
5. Move export rendering into a worker; add golden-frame and A/V sync tests.
6. Project packages, people clusters, flipbooks, video scan stage.
