# Lantern: development status and handoff

Status as of 2026-11-14 (sixth session): **a working vertical slice, deployed on GitHub Pages, with music fixed, creative looks removed, and Depth Space (M5) mostly built: depth, derived mattes and plates, two-layer meshes, depth wipe and fly-through.** Import
photos and songs, get an automatically planned 2D show with beat-synced cuts, edit it in the
editor, export an MP4. All of it was exercised end to end in headless Chromium by the Playwright
test (`tests/e2e/show.spec.ts`) against the owner's local `example_photos/` folder. The owner
has committed ("Basics working") and deployed to GitHub Pages.

## Session 6 (2026-11-14): generative fill behind people (M6)

Opt-in (Show tab → Generative fill: Off / Behind people; project `generativeFill: "all"`). All 21
plates on the example photos pass the guard; arc end frames show clean edges, no ghost cutouts.
Not yet seen on a GPU or in a real (non-headless) browser by the owner.

- **Fill model: LaMa** (`src/lib/analysis/fill.ts`, registry `lama-512`): Carve's ONNX export of
  big-lama, Apache-2.0; now 106 MB fp16-stored weights from the owner's repo (see below). Fixed 512²: `image` f32 0–1 with
  hole pixels zeroed, `mask` f32 1 = fill, `output` f32 0–255. ~6 s per photo on one CPU thread
  (Node); the e2e run took ~5.5 min for 24 photos including the download. A square crop around
  the hole (+ pad) is scaled to 512 and back; only hole pixels are kept → `plategen.webp`.
  Soft/hazy deep inside big holes, which a move never uncovers; good near the edges.
- **MI-GAN was tried and rejected** (MIT, 28 MB): its pipeline does not erase pixels under the
  mask (the removed person leaked into the fill: invented figures in their colours), and even
  with the hole greyed it paints dark figure-like blobs into person-sized holes, whatever the
  mask's shape. A band-only fill over the classical plate came out flat. Notes in the registry.
- **Whole people on one layer** (`wholePeople` in `layers.ts`): DeepLab v3 person mask (MediaPipe
  Image Segmenter, Apache-2.0, 2.8 MB) runs before depth (`runSegment`), saved as `people.u8.gz`.
  Each person blob joins the matte when the depth threshold already holds ≥ 50 % of it, else
  leaves it. Fixes the depth matte slicing seated / partly hidden people. `DEPTH_VERSION` 4.
- **Person guard** (all in the `fill` stage, `queue.ts`): EfficientDet-Lite0 person boxes
  (Apache-2.0, 7.3 MB) on the original and the composite, face detector on the composite.
  Rejected when a face ≥ 0.5 is ≥ 25 % inside generated pixels (faces larger than 2× the photo's
  largest real face are texture: a 378 px "face" on fence posts), or a new person ≥ 0.5 is ≥ 25 %
  inside and matches no original person that is mostly outside the hole. Person-mask blobs that
  touch the hole are hidden from the model (`peopleKeepOut`), unless that hides over half the
  crop's context. Three attempts with growing context (`FILL_ATTEMPTS`); the last rejected plate
  is kept as `plategen.rejected.webp` and the reason logged as `[fill] …` for debugging.
- **PatchMatch** (`inpaint.ts`) refines the classical plate, now never copying from person pixels.
  Used when fill is off or rejected. Weak on very large holes (flat smear).
- `frames.spec.ts`: `FRAMES_FILL=1` turns fill on, prints `[fill]` rejections, dumps `NN-people.png`,
  `NN-plategen.webp`, `NN-plategen.rejected.webp`. Pass `--timeout 1500000` (LaMa is slow).

Smaller LaMa: 8-bit dynamic quantization is unusable (green checkerboard, error > 100 levels).
fp16-stored weights with load-time Casts to fp32 (`convert_fp16_weights.py` in the repo) give
106 MB, mean error 0.56/255, same speed. Hosted at `HiggityPiggity/lama-onnx-fp16` (owner's HF
account, public, Apache-2.0); registry `lama-512` pins commit `feb119a` and SHA-256 `e631637d…ecab`
(verified by download).

Next for M6: WebGPU
provider for speed; mirrored crops at frame edges (spec §4.6); margins / Extend; the
"show generated pixels" overlay; plate depth from a depth pass on the plate. Undo of the fill
switch does not re-run `applyFill` (switch it again).

## Session 5 (2026-11-14): owner's observations (`Observations.md`)

Done (unit tests 31/31, `npm run check` clean, `show.spec.ts` e2e passes; not yet eyeballed on a GPU):

- **Beat accents** no longer jolt: the 2.5 % zoom pulse (which started at full strength on the
  beat) is replaced by `warpedProgress` in `renderer.ts`, a smooth surge of the move's progress
  after each downbeat; path, start and end are unchanged. Unit-tested for continuity.
- **Sweeps/tours** glide: `cameraAt` uses monotone (Fritsch–Carlson) cubic Hermite for tracks
  with more than two keys, so the camera no longer stops at every intermediate key; it still rests
  on dwell keys and the ends. `SWEEP_SPEED` 0.5 → 0.3 and `panSpeed` now also counts zoom
  (0.5 × |log Δsize|), so fewer sweeps/tours qualify on short slides (they fall back to push).
- **Depth wipe pop**: the threshold ramp started at 0, so far-plane pixels of the incoming photo
  showed at ~50 % on frame one (looked like a mask cropping the outgoing photo). Ramp now starts at −f.
- **Inspector tab** no longer flips back to Slide on every show/music edit (it switched whenever
  the slide object was rebuilt; now only when the selection changes).
- **Wheel** scrolls the storyboard and timeline horizontally (Ctrl+wheel still zooms the timeline).
- **Edit framing**: the box squashed because the flex column shrank the aspect-ratio container
  (`flex: none` now); resize handle follows horizontal drags too.
- **Title cards**: `project.titles.cards` (`TitleCard`: id, text, `before` media hash). "+ Title
  card" in the bottom bar adds one before the selected slide (or at the end); removing a title slide
  (button or Delete) clears it at its source (`app.removeSelected`), so the planner no longer
  resurrects it and the intro/end fields in Show can bring it back; editing a title slide's text
  writes to the source (`app.setTitleText`). A card whose anchor photo is removed moves to the end.
- **Focal tiers** without faces: depth-matte subject box (`DepthInfo.matte.box`, new analyses
  only; no `DEPTH_VERSION` bump, older caches fall back) → saliency peaks ranked by score × √area.
- **Music**: per-song "Use in show" toggle (`SongRef.off`, skipped by `musicGrid`), ↑/↓ order, and
  a too-short / too-long message at the top of the Music tab.

Not done, for the next session:

- ~~Ghost cutouts behind people in 3D moves~~: done in session 6 (PatchMatch plates).
- **Music management** beyond the above: drag reorder, auditioning a song from the list, adding
  songs from the Music tab (today: library drawer only), suggesting how many photos/songs fit.
- Title cards: no per-card subtitle or style (title vs chapter) choice; automatic chapter cards are
  still the Show toggle.
- Framing editor edits only the first and last keys and shows nothing of the 3D camera.
- Check by eye on real photos whether sweeps still feel fast; `SWEEP_SPEED` and the zoom weight in
  `panSpeed` are the knobs. Look for other pops: fly-through starts A's zoom at 1.0 (fine), but the
  whip's blur and half-frame offset may still read as a jump.

## Session 4 (2026-11-11): the 3D effect rebuilt (mattes, plates, two layers)

The owner found the first 3D "jagged and distorted". Cause: one mesh carried the whole photo, so
every depth edge stretched triangles into a sawtooth, the depth texture was 8-bit, the offscreen
targets had no multisampling, and the arc/crane amplitudes asked for far more parallax than one
layer can bear. What changed (all verified on frame dumps of the owner's example photos, see
`tests/e2e/frames.spec.ts` → `test-results/frames/`; a copy of the old frames is in
`test-results/frames-before/` locally):

- **Layers from depth, no new model** (`src/lib/analysis/layers.ts`, unit-tested): the depth
  stage now also builds a subject matte (soft depth threshold in the histogram valley between the
  subject box and its surroundings; Otsu's split as the fallback, so pets and statues work), a
  background plate (pull-push pyramid fill of the hole, colour and depth together) and a smoothed
  background depth. Files: `platedepth.u16.gz` (always), `matte.u8.gz` (two planes: tight and
  grown alpha) and `plate.webp` (alpha = hole) when a layer exists. `DEPTH_VERSION` is 2, so old
  caches re-run depth. `DepthInfo.matte` carries the threshold and cover; `sep`/`pivot` are now
  measured on the matte and the probe grid comes from the background depth (so the edge clamp
  matches the layer that actually covers the frame edge).
- **Renderer** (`src/lib/render/renderer.ts`): maps texture is RGBA16F (R background depth, G
  subject depth extended past the matte by pull-push and lightly smoothed, B grown alpha, A tight
  alpha); the background layer blends the plate over the photo inside the hole; the subject layer
  draws only when a plate exists; grid 128 (64 lite) with 32-bit indices and alternating
  diagonals; 4× MSAA render targets with a second colour attachment holding screen-space depth;
  depth wipe (far first, subject last) and fly-through (outgoing zooms in, planes dissolve nearest
  first) in the composite pass; `renderer.debug = 1|2` shows a target's depth for frame dumps.
  `AssetLoader.loadLayerTextures` is shared with the exporter.
- **Planner**: ARC 0.24 → 0.09, CRANE 0.15 → 0.07, INFLATE 0.14 → 0.07, DOLLY 0.12 → 0.1;
  Cinematic `depthAmount` 1.2 → 1; arc/crane/inflate suitability halves without a matte.
- **Stall watchdog** (`queue.ts`): multi-threaded ONNX Runtime session creation hung forever in
  headless Chromium 158 with cross-origin isolation on (the preview server inherits the dev
  COOP/COEP headers, so the Playwright runs are isolated). A depth job that sends nothing for 90 s
  now gets its worker terminated and is retried single-threaded; threads stay off for the session.
  Whether threads work in real browsers is still unknown.
- **Harness**: `window.lantern` (the app state) and `window.lanternPlayer` are exposed for tests;
  `tests/e2e/frames.spec.ts` forces treatments (`FRAMES_TREATMENTS=arc,crane`), transitions
  (`FRAMES_TRANSITION=depthWipe|flyThrough`) and dumps frames, depth maps, mattes and plates.

What still shows: the pull-push fill is a blur of the rim, so a strong parallax reveals a soft
band around subjects (an inpainting model, M6, is the fix; amplitudes are moderate meanwhile);
several people at different depths share one subject layer, so the step between them is a gentle
warp; depth-threshold mattes cut continuous surfaces (a floor at the subject's feet) with a soft
seam. Disc DOF is still the mip-bias blur.

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
| Analysis | `src/lib/analysis/` | Basics (pHash, sharpness, exposure, colourfulness, edge density, flags) and spectral-residual saliency at import; MediaPipe faces (tiled) and Depth Anything V2 Small (ORT WASM) plus depth-derived layers (`layers.ts`: matte, plate, background depth) in a priority queue with versioned, cached results and a stall watchdog. |
| Models | `src/lib/models/` | Registry with pinned URL/size/SHA-256/license, checksummed fetch into Cache Storage, Settings page lists and deletes them. |
| Renderer | `src/lib/render/` | WebGL2, pure function of time, two depth-displaced meshes (background with plate, subject with matte alpha) + letterbox + MSAA targets with depth attachment + composite transitions (incl. depth wipe, fly-through) + captions + beat pulse; asset window loader (photos, maps, plates); preview Player with audio-locked clock. |
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
| M5 | Depth Space | Mostly done: depth stage, depth-derived mattes and pull-push plates, two-layer meshes, depth wipe and fly-through, 3D treatments when depth and a style with `depthShare > 0` allow. Missing: disc DOF, a segmentation model for finer mattes (full tier), WebGPU provider, GPU timings, threshold tuning on more photos. |
| M6 | Fills | Plates done (opt-in): LaMa fill, person segmentation keeps whole people on one layer, face + person guard, PatchMatch fallback. Missing: smaller/faster model, mirrored crops, margins/Extend, generated-pixels overlay, plate depth. |
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
- Plates are classical pull-push fills (blurry); no inpainting model and no person guard yet (nothing generative exists, so the guard has nothing to check). The parallax band around subjects shows the blur.
- Multi-threaded ONNX Runtime hung in headless Chromium; the watchdog falls back to one thread. Unverified in real browsers.
- Playwright uses SwiftShader; GPU performance is unmeasured. Chrome headless had no AAC encoder (Opus-in-MP4 was used).
- The `.lantern` project package is not implemented.
- The e2e test skips the picker and uses the download path.

## Next steps

1. Verify cross-origin isolation and model fetches on the deployed Pages site (spec §2.1); the owner reports the deploy works, isolation is unchecked.
2. Measure beat accuracy on real songs (spec §6.2 targets) and GPU render/export speed; record in spec §13.1.
3. M5 Depth Space, finishing: look at real 3D moves on a GPU (the owner's machine) and tune `quality`/`sep` gates and amplitudes by eye; disc DOF; try the WebGPU provider with the fp16 export for speed; consider a person segmenter (MediaPipe multiclass, Apache-2.0) or BiRefNet-lite (MIT, full tier) to refine the depth-derived matte where people are present.
3b. M6 Fills, continuing: owner to eyeball fills on a GPU; 8-bit LaMa (needs a host), margins/Extend, the generated-pixels overlay, mirrored crops at frame edges.
4. CLIP ViT-B/32 image tower + build-time tag embeddings (`npm run tags` is declared but the script does not exist yet).
5. Move export rendering into a worker; add golden-frame and A/V sync tests.
6. Project packages, people clusters, flipbooks, video scan stage.
