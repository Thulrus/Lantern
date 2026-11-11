# Lantern: product and technical spec

*Status: draft v0.1, 2026-11-10. Named after the magic-lantern slideshows of the 1800s. This is the
founding document of a new public repo, built from what worked in Flicker. It is written for the
agent that builds the app.*

## 0. Read this first (for the building agent)

- **This is a new product, not a fork of Flicker.** Flicker is a private, single-user viewer for
  one specific collection. Lantern is a public, general-purpose slideshow creator for anyone's
  photos and videos: family, travel, weddings, memorials, pets, events. Section 14 lists which
  Flicker code to port and what to leave behind.
- **Leave out every trace of Flicker's subject matter.** Do not port the NudeNet regions stage, body-region labels,
  pose presets, the LAN server, device pairing, PINs or panic. Do not copy Flicker's docs,
  comments, test fixtures, constant names or commit history into the new repo. Port the
  algorithms and rewrite their comments for the new context.
- **Flicker's source is at `/mnt/Secondary/Projects/Code/Flicker`** (a separate, private repo).
  Paths in §14 are relative to it. Read it; never copy files from it wholesale.
- **Never open Flicker's data directory or photo collection** (`/media/veracrypt1/...`). Read
  Flicker's *source code* only. Lantern's tests use synthetic images and openly licensed (CC0)
  sample photos (§12).
- Items marked **[verify]** are assumptions about browsers, libraries or licenses that Phase 0
  (§11, M0) must confirm before you build on them. Treat them as hypotheses, not facts.

## 1. What it is

Lantern turns a folder of photos and videos, plus one or more songs, into a cinematic slideshow
that **builds itself**: it understands each picture (faces, people, depth, subject, quality),
then plans the camera moves, timing and transitions around both the pictures and the music.
The user can then change anything. The finished show exports to a video file.

It runs **entirely in the browser**, hosted as a static site on GitHub Pages. No photo, video,
song or analysis result ever leaves the user's device. No account, no upload, no server.

### 1.1 What makes it different

Most slideshow tools pan and zoom at random over a flat picture. Lantern knows what is in the
picture:

| The picture | What Lantern does |
|---|---|
| One face | A slow push-in that lands with the eyes on the upper third. The face is never cut by the frame edge. |
| A group of people | Slows down for it, and pans across the row of faces so each one gets a moment. It starts or ends with everyone in frame. |
| A person in front of a scene, with good depth | **Depth Space**: the photo becomes a small 3D scene. The camera dollies or orbits and the background turns behind the person with real parallax. |
| A landscape with no people | A slow lateral drift or a 3D push into the scene toward the most interesting area. |
| A burst of near-identical shots | Either keeps the best one (sharpest, eyes open) or plays them as a stabilized stop-motion flipbook. |
| A portrait photo in a landscape show | Pairs it with a neighbouring portrait as a diptych, extends the background past the frame (never the person), tilts along it, or sits it on a blurred copy of itself. |
| A screenshot or a photo of a document | Holds it longer and still, so it can be read. |
| A video clip | Finds the best few seconds (faces, motion, steady camera) and cuts them on the beat. If people are talking, it lowers the music under them. |
| A song | Finds the beats, bars and sections. Cuts land on beats, big transitions land on section changes, quiet passages get slower moves, and the show ends with the song. |

### 1.2 Principles

1. **The person is never altered.** This is the product's trust promise, shown in the UI. Pixels
   of a person (inside their matte, plus a small safety margin) always come from the source,
   changed only by geometric moves, blends, masks and global colour math. No face retouching,
   no AI upscaling of people, no face swaps, no body warps (Flicker's "breath" effect is *not*
   ported).
   - **Generative fill is allowed only outside people:** the background behind a person when
     the camera moves, gaps opened by parallax, and area beyond the photo edge. It must never
     extend a cropped body, and a generated area that contains a person is rejected (the
     *person guard*, §4.6). The user can switch generative fill off entirely, and can show an
     overlay of every generated pixel.
   - **Morph transitions between different people are off by default.** A morph that blends
     two faces synthesizes a person who does not exist. Morphs are offered only between photos
     of the same identity cluster, and only when the user enables them.
2. **Auto first, then hand control.** A good show must come out of "pick photos, pick a song,
   press Make" with no other input. Every automatic decision can be overridden and locked, and
   re-running the automation never undoes a locked choice.
3. **One renderer.** Preview and export draw frames with the same code, as a pure function of
   time. What you see in the preview is what the file contains.
4. **Progressive quality.** The show is playable within seconds using cheap analysis (faces,
   thumbnails, beats). Depth, mattes and fills arrive in the background, and slides upgrade to
   3D as their data lands.
5. **Local only.** The only network traffic is the app itself and the model weights. Both are
   cached so the app works offline after the first use.

### 1.3 Non-goals (v1)

- Cloud storage, accounts, sharing links, collaboration.
- Importing from Google Photos, iCloud or social networks (files and folders only).
- A full video editor: no multi-track video compositing, keyframe curves for arbitrary
  properties, or audio editing beyond trims, fades, crossfades and ducking.
- RAW photos.
- A bundled music library. Users bring their own songs (a few CC0 demo tracks are fine, §15).
- Generative imagery of any kind beyond background fill.

## 2. Is GitHub Pages possible? Yes.

Everything in this spec runs client-side. GitHub Pages only has to serve static files. The
pieces that make this realistic now:

| Need | Browser technology |
|---|---|
| Neural analysis (depth, faces, mattes, fill, embeddings) | **ONNX Runtime Web** with the WebGPU execution provider, and a WASM fallback. **MediaPipe Tasks** (vision) for faces and pose. |
| 3D rendering | WebGL2 (Flicker's renderer is already WebGL2). WebGPU is optional later. |
| Music analysis | Web Audio `decodeAudioData` plus DSP in a worker (JS or WASM). |
| Video decode and encode | **WebCodecs** (`VideoDecoder`, `VideoEncoder`, `AudioEncoder`), with **Mediabunny** for demuxing and muxing MP4/WebM [verify current API]. |
| Big local storage | **OPFS** (Origin Private File System) for derived files, IndexedDB for metadata. |
| Re-opening folders across sessions | File System Access API (Chromium only). Other browsers copy working proxies into OPFS. |
| Saving a large export without holding it in RAM | `showSaveFilePicker` and a writable stream (Chromium). Elsewhere, write to OPFS and then download. |
| Keeping the screen on during export | Screen Wake Lock (Pages is HTTPS, so it is a secure context). |
| Working offline | A service worker caches the app shell and the model weights. |

### 2.1 Pages constraints and how to handle them

| Constraint | Consequence | Plan |
|---|---|---|
| No custom response headers | No COOP/COEP, so no `SharedArrayBuffer`, so ONNX Runtime WASM runs single-threaded. | The app's own service worker adds COOP/COEP to every response it serves (the `coi-serviceworker` technique), which enables cross-origin isolation after the first load. Merge this into the one app service worker, since a scope can only have one. Feature-detect `crossOriginIsolated`. The WebGPU path does not need isolation. **[verify]** in Chrome, Firefox and Safari, including model fetches under COEP (the model host must send CORS headers; consider `credentialless`). |
| 100 MB per file, about 1 GB per site, soft bandwidth limit of 100 GB per month | Model weights must not live in the Pages repo. | Host the weights in a project-owned **Hugging Face** model repo, pinned to a revision and fetched with CORS. Verify each file's SHA-256 before use (as Flicker's `models.fetch` does) and cache it in Cache Storage. Download weights lazily, per feature, with sizes shown to the user. |
| Static only | No server-side rendering or analysis. | None is needed. |
| If isolation via a service worker turns out to be unreliable | — | Fallback host: Cloudflare Pages or Netlify, both of which set headers from a `_headers` file. The app itself does not change. |

### 2.2 Device tiers

The app picks features by detected capability, not by browser name.

| Tier | Typical device | Analysis | Preview | Export |
|---|---|---|---|---|
| **Full** | Desktop or laptop with Chromium and WebGPU | All stages, including fill and mattes | 60 fps, 3D | Up to 4K, faster than real time on a discrete GPU [verify] |
| **Standard** | Desktop Safari or Firefox, or Chromium without WebGPU | WASM models, lite variants, smaller batches | 3D | 1080p |
| **Lite** | Phones and tablets | Faces, beats and small-model depth. No fill. Up to ~150 photos. | 3D at lower mesh density | 1080p if WebCodecs encode works [verify], else none |

The UI tells the user their tier, and suggests a desktop for large shows.

## 3. Architecture

```text
 ┌────────────────────────────────── Browser tab (static site) ───────────────────────────────┐
 │                                                                                           │
 │  Import ──► Media store (OPFS proxies + IndexedDB records, keyed by content hash)          │
 │                │                                                                          │
 │                ▼                                                                          │
 │  Analysis workers (job queue, one model resident per worker, versioned results)           │
 │     fast: EXIF · thumbs · pHash · sharpness/exposure · faces · CLIP                        │
 │     deep: pose · matte · depth · plate/margins (on demand, playhead first)                │
 │     audio: beats · downbeats · sections · energy · loudness                                │
 │     video: keyframes · motion · faces per sample · speech (VAD)                            │
 │                │                                                                          │
 │                ▼                                                                          │
 │  Planner (pure TS, deterministic, seeded) ── Project JSON ──► Editor UI (Svelte 5)        │
 │      curate · order · group · durations · music fit · motion · transitions · validate     │
 │                │                         ▲ user edits + locks                             │
 │                ▼                         │                                                │
 │  Timeline (render contract) ──► Renderer (WebGL2, frame = f(timeline, t))                  │
 │                                     ├── Preview: rAF clock, real time, live audio          │
 │                                     └── Export: fixed timestep in a worker ──► WebCodecs   │
 │                                                    + OfflineAudioContext mix ──► MP4 file  │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key decisions**

- **The planner is pure.** `plan(project, analysis, music, options) → Timeline` has no side
  effects and no hidden state. All randomness comes from a seeded PRNG whose seed is stored in
  the project. The same inputs always produce the same show.
- **The timeline is the contract** between planner, editor and renderer (§8). It is the
  descendant of Flicker's Scene JSON.
- **The renderer is a pure function of time.** `drawFrame(timeline, t, assets)` never reads
  the wall clock. Preview and export differ only in who advances `t`.
- **Analysis is a cache, never a requirement.** Every planner rule has a fallback when its
  input is missing (no depth → 2D move; no faces → saliency; no saliency → centre).

### 3.1 Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) |
| UI | Svelte 5 + Vite (as in Flicker; port its `ui/` components) |
| Rendering | Raw WebGL2. Port Flicker's `gl.ts` and `stills.ts`. |
| Inference | `onnxruntime-web` (WebGPU, then WASM); `@mediapipe/tasks-vision` for faces and pose |
| Workers | Web Workers with Comlink, plus `OffscreenCanvas` for export rendering |
| Media I/O | WebCodecs + Mediabunny [verify]; `exifr` for EXIF; `libheif-js` (WASM, lazy-loaded) for HEIC where the browser cannot decode it |
| Hashing | `xxhash-wasm` (xxh3, as Flicker uses) for identity |
| Storage | IndexedDB (via `idb`) + OPFS |
| Audio DSP | TypeScript in a worker, optionally a WASM FFT. Optional neural beat model on ONNX Runtime (§6.2). |
| Tests | Vitest (planner, DSP, data), Playwright (e2e, golden frames, export round trip) |
| Hosting | GitHub Pages via a GitHub Actions build and deploy |

## 4. Import and analysis

### 4.1 Import

- Drag and drop files or folders, or use the file and folder pickers. In Chromium, keep a
  `FileSystemDirectoryHandle` so the project can reopen its folders in later sessions (with
  re-permission). Elsewhere, files are readable only during the session, so Lantern stores
  **working proxies** in OPFS (photos at 2560 px long edge, quality ~0.85) and asks the user to
  relink originals when it needs them (4K export, video).
- **Identity** is the xxh3 hash of the file's bytes, so re-imports and renames keep their
  analysis.
- Photos: JPEG, PNG, WebP, AVIF, HEIC/HEIF, GIF (first frame). Apply EXIF orientation.
- Videos: MP4/MOV (H.264, HEVC where the platform decodes it), WebM. A codec the browser can't
  decode is flagged in the library with a clear message.
- Live Photos and motion photos: import the still. Using the motion part is a later feature.
- Metadata kept: capture time (EXIF `DateTimeOriginal`, falling back to file time), camera,
  GPS (used only on-device for chaptering), dimensions and duration.
- Typical show: 30–500 items. Design limit: 2,000 items per project.

### 4.2 Analysis stages

Each stage is independent, resumable and versioned. A result is keyed by
(content hash, stage, model id, params hash) and reruns when any of those change. This is
Flicker's stage runner (`stages/base.py`), including `requires`: a stage waits for the stages
it needs.

| Stage | Output | Tier | Runs on |
|---|---|---|---|
| **Basics** | thumbnail (320 px), proxy, EXIF, pHash, sharpness (variance of Laplacian on a fixed-size grey proxy), exposure and contrast histogram stats, colourfulness | all | every item on import |
| **Faces** | per face: box, 5 landmarks, score, size; eyes-open and smile scores where the model gives them; identity embedding | all | every photo; sampled video frames |
| **Embedding** | CLIP image embedding; zero-shot tags (below) | all | every item |
| **Saliency** | a saliency map, or its peak boxes, for pictures without people | all | every photo |
| **Pose** | person boxes and body keypoints (used for framing so moves don't cut at joints, for aim points, and for burst stabilization) | standard+ | photos with people |
| **Matte** | soft subject matte: people, or the salient subject (a pet, a statue) | standard+ (lite: a person-only segmenter) | photos in the show |
| **Depth** | relative inverse depth, 16-bit | all (lite: small input size) | photos in the show |
| **Plate** | background with the subject removed (only inside the grown matte), its depth, and margins outpainted past the frame on sides the subject does not touch; person-guard verdict | full | slides whose plan needs it |
| **Video scan** | per sampled frame (2 fps): faces, motion energy, shake, sharpness; audio RMS and speech probability (VAD) | standard+ | every video |
| **Music** | §6 | all | every song |

**Zero-shot tags** come from CLIP image embeddings compared against text embeddings computed
**at build time** and shipped as a small JSON file, so the browser needs only CLIP's image
tower. The starter tag set: `screenshot, document or text, food, landscape, cityscape, beach,
sunset, night, indoor, group photo, selfie, pet, baby, wedding, concert, sports, snow, art`.
Each tag gets a calibrated threshold, tuned on the Phase 0 sample.

### 4.3 Model candidates

Licenses matter: the app is public, so pick permissive licenses and avoid non-commercial
weights. Phase 0 (M0) benchmarks these, and every row is **[verify]** for license, browser
compatibility and size.

| Task | Primary | Fallback | Notes |
|---|---|---|---|
| Face detection | MediaPipe Face Detector, full range (Apache-2.0) | YuNet (MIT, OpenCV zoo), multi-scale | Avoid InsightFace SCRFD/ArcFace weights: their license is non-commercial research only. Flicker used them; Lantern cannot. Group photos need small-face recall, so test a 20-person group. |
| Eyes open, smile | MediaPipe Face Landmarker blendshapes (`eyeBlink*`, `mouthSmile*`) | none (skip the "best of burst" signal) | |
| Face identity | SFace (Apache-2.0, OpenCV zoo) | none (no People feature) | Flicker found YuNet+SFace weaker than SCRFD+ArcFace; good enough for "group these faces", with user merge and split. |
| Pose | RTMPose or RTMO (Apache-2.0) ONNX | MediaPipe Pose Landmarker | Flicker's RTMW-x is heavy; a lighter body-only model is enough here. |
| Subject matte | BiRefNet-lite (MIT), full tier | MediaPipe selfie / multiclass segmenter; MODNet (Apache-2.0) for portraits | BiRefNet-lite took ~450 ms per image on an RTX 3060 in Flicker; in a browser expect several times slower [verify]. Avoid RMBG weights (non-commercial). |
| Depth | Depth Anything V2 **Small** (Apache-2.0; Base and Large are CC-BY-NC, so do not use them) | the same model at a smaller input size | Flicker: Small was as good as Base. |
| Background fill | MI-GAN (mobile inpainting, 512 px) [verify license] | LaMa big (Apache-2.0, 208 MB, full tier only) | Flicker used LaMa for plates and margins successfully. MI-GAN is far smaller; compare their quality on margins in Phase 0. Classical push-pull fill (Flicker `layers.py`) is the no-model fallback. |
| Embedding | CLIP ViT-B/32 image tower (MIT), quantized | none (order by time only) | Flicker used ViT-L/14 (98% usable); B/32 is the browser-sized compromise. MobileCLIP is an option if its license allows [verify]. |
| Saliency | U²-Net-p (Apache-2.0, ~5 MB) | spectral-residual saliency (classical, no model) | |
| Speech activity | Silero VAD (MIT, ~2 MB) | an energy-and-spectral-flatness heuristic | |
| Beats and downbeats (optional) | "Beat This!" (MIT) ONNX [verify size and export] | DSP beat tracker (§6.2), the default | |

Rules carried over from Flicker:

- One model resident per worker; load, process the batch, unload. On mobile, run one analysis
  worker at a time.
- Batch sizes back off on out-of-memory errors.
- Mattes and depth only run where they're needed (Flicker ran them only on photos with a
  confident person). Here: only on photos in the current show, nearest the playhead first.

### 4.4 Scheduling

A single priority queue feeds the workers.

1. **Basics** for every import (blocks nothing; the library fills in as it goes).
2. **Faces + Embedding + Saliency** for every item (needed for curation, order and the first
   plan).
3. **Pose + Matte + Depth** for photos in the show, in timeline order, with the slides around
   the playhead or the selection promoted.
4. **Plate** only for slides whose chosen treatment benefits (deep 3D moves, outpainted fill
   for aspect ratio).

Analysis status is visible per item (small dots in the library and on slide cards) and overall
("3D ready for 84 of 120 slides").

### 4.5 Curation signals (computed from analysis)

- **Duplicates and bursts**: pHash groups with **complete linkage** (every pair within the
  threshold). Flicker found that single linkage chained a whole shoot into one group. Add a
  time constraint: same burst means within 10 s of capture time.
- **Best of group**: rank by sharpness, eyes open, smile, face size and exposure. Keep the
  first; the rest stay available as alternates.
- **Quality flags** (suggestions, never automatic deletion): blurry, very dark, blown out,
  screenshot or document, tiny resolution relative to the output (would need more than 1.25×
  upscaling at the export size).
- **People**: identity clusters from face embeddings. Users can name a cluster, merge two and
  split one. Names stay on the device.
- **Moments**: capture-time gaps over a threshold (adaptive: the 90th percentile of gaps, at
  least 2 h) and GPS jumps over 20 km start a new chapter.

### 4.6 Plates, margins and the person guard

Ported from Flicker's Plate stage (`analyzers/inpaint.py`, `stages/analysis.py`
`PlateStage`, `layers.py`), with the subject generalized from "the figure" to "people and
the main subject":

- **Hole** = the matte (> 0.1), grown by 1.2% of the long edge, plus padding. Only hole pixels
  change, so at rest a slide composites back to the exact photo.
- Fill a square crop around the hole at the model's native size. Where the square runs past
  the frame, mirror the context *and the mask* (Flicker found that a mirrored subject leaked
  into the context otherwise).
- **Plate depth**: run depth on the plate and fit it to the photo's depth by least squares
  away from the subject, then refit without the worst 20%.
- **Margins**: outpaint by 12% of the long edge on each side the subject doesn't touch (at most
  0.2% subject pixels in a 1% edge band). Use overlapping windows, most-known first.
- **Person guard**: run the person detector on the photo and on the result. A confident person
  box (≥ 0.5) that lies ≥ 25% inside generated pixels and matches no person in the original
  counts as invented, so the plate (or the margins) are rejected. Flicker rejected 3.7% of
  plates this way. Also run the face detector on generated pixels, since a background face
  is the most visible failure.
- **Transparency**: the inspector can tint generated pixels (an overlay toggle) on any slide.

## 5. The automatic director (planner)

The planner turns analysed media plus settings into a timeline in seven passes. Each pass is a
pure function with tests. Each decision records a short **reason** string, which the editor
shows ("3 faces → group sweep, 5.2 s = 4 bars").

### 5.1 Pass 1: curate

- Collapse duplicate groups to their best member (alternates kept).
- Mark quality-flagged items as *suggested out* (dimmed, included only if the user says so).
- If the user picked a **featured person**, weight slides containing them (§5.9).

### 5.2 Pass 2: order

- **Chronological** (default): capture time, with chapters from §4.5.
- **Story**: chronological at the chapter level. Within a chapter: open on an establishing
  shot (landscape or cityscape tag, no or small faces, high quality), place group shots near
  chapter starts and ends, and put close-ups in between. Within those constraints, order by a
  greedy nearest-neighbour path in CLIP space, so consecutive slides relate visually. (Flicker's
  Stills already walk embedding neighbourhoods.)
- **As imported** and **Shuffle** (seeded).
- Variety rules: no two near-duplicates adjacent (unless they form a flipbook); prefer
  alternating orientations when pairing is off; no single person in more than 4 slides in a row
  unless featured.

### 5.3 Pass 3: group

Some slides use more than one item.

- **Diptych / triptych**: in a landscape show, two portrait photos within the same chapter and
  within 30 min of each other (or within CLIP distance threshold) may share a slide, split by a
  thin gutter. Each half gets its own gentle move, offset in phase. A triptych is three
  portraits in an ultra-wide show or a 2 × 2 grid for a burst of four.
- **Flipbook**: a burst of 4–15 near-identical frames plays as stop-motion at 8–12 fps, each
  frame stabilized onto the first. Stabilization uses Flicker's Aligner: a similarity transform
  fitted to face and body keypoints, with scale from the ratio of spreads (Flicker found
  least-squares scale shrinks the subject at each step), and a low-pass filtered target.
- **Grid reveal** (Upbeat style only): 2 × 2 or 3 × 3 cells filling in on successive beats,
  then the last cell expands to full screen. This descends from Flicker's Chorus layout.
- **Title cards**: an intro, chapter cards (date or user text), and an end card.

### 5.4 Pass 4: desired durations

`desired = pace_base × Π multipliers`, clamped to `[min, max]` of the style.

| Signal | Multiplier |
|---|---|
| Pace preset (base seconds) | Gentle 5.5, Balanced 4.0, Lively 2.6, Rapid 1.6 |
| Number of faces *n* (n ≥ 2) | 1 + 0.15 (n − 1), up to 1.8 |
| Visual complexity (edge density, CLIP "detailed" score) | 0.9–1.2 |
| User star | 1.5 |
| Screenshot or document | 1.6, with a minimum of 4 s |
| Diptych | 1.3 |
| Treatment minimum | arc ≥ 4 s, group sweep ≥ 1.0 s per face + 1.5 s, tour ≥ 1.2 s per stop |
| Video | its selected clip length (§7) |
| Section energy (when music is on) | high energy 0.75, low 1.3 (§6.3) |

### 5.5 Pass 5: fit to music

Turns desired durations into actual cut times on the music's beat grid.

- **Fit mode** (user choice):
  - *Fit show to music* (default when music is present): the show ends with the music.
  - *Fit music to show*: the music is trimmed at a phrase boundary and fades out, or a section
    loops (repeat a section, joining on matching downbeats) to make it longer.
  - *Free*: durations as desired, music plays underneath, cuts still snap to the nearest beat
    if "Cuts on beats" is on.
- **Algorithm** (dynamic programming, in a worker):
  - Candidate cut points are beats. Downbeats and section boundaries are preferred.
  - Choose cut beats b₀ < b₁ < … < bₙ, with b₀ = start and bₙ = end, minimizing
    Σ (ln(actualᵢ / desiredᵢ))² + λ₁ · [cut not on a downbeat] + λ₂ · [major transition not on
    a section boundary] − λ₃ · [chapter change on a section boundary].
  - Constrain each actualᵢ to [0.6, 1.6] × desiredᵢ and to the slide's locked duration if
    locked.
  - The state is (slide index, beat index), with a window of beats around the expected
    position. 500 slides × 2,000 beats × a window of 32 is about 32 M operations, which is fast
    enough in a worker.
- **Mismatch handling**: if no solution fits within the bounds, tell the user plainly ("The
  photos need about 4:10; the music is 2:55") and offer options: speed up the pace, leave out
  the lowest-ranked slides (shown as a list to confirm), add another song, loop a section, or
  fade out early.
- Without music, cut times come from desired durations directly (optionally on a tempo grid
  from the style).

### 5.6 Pass 6: treatment (motion, fill, look)

For each slide, every treatment has a **suitability score** from 0 to 1, computed from analysis
features. The planner chooses by weighted random draw (seeded) over `suitability × style
weight × variety penalty`. It keeps the top three as alternates for the editor's "Try another".

**Treatments** (camera model in §9.1):

| Treatment | What it does | Favoured when | Needs |
|---|---|---|---|
| Hold | still, with a 2% drift | screenshot, document, very short slides | — |
| Push in / Pull out | Ken Burns zoom toward or from a focal target | one face, one salient subject | faces or saliency |
| Pan | lateral or vertical travel across a wide or tall picture | aspect much wider or taller than the output | — |
| **Group sweep** | travels along the row of faces, easing (dwelling) near each, ending wide | ≥ 3 faces | faces |
| Tour | 2–4 stops at points of interest, then the full frame (Flicker's detail tour) | 2+ distinct subjects, high resolution | faces or saliency |
| Depth push | 3D dolly in with real parallax | good depth separation | depth (+ matte) |
| Depth orbit / Arc | camera circles the subject with look-at (Flicker's Arc) | strong separation, a plate available | depth, matte, ideally plate |
| Crane | camera rises or sinks while aiming at the subject | tall subjects, landscapes with a foreground | depth |
| Inflate | the flat photo swells into 3D as the camera starts to move | an accent: a section start or the first slide of a chapter | depth |
| Dolly zoom | vertigo push with opposite zoom | rare accent on a musical peak | depth, strong separation |
| Focus pull | synthetic depth of field racks from the background to the face | portraits with depth | depth |

**Features used by the scores** (all optional): face count, largest face size, face positions,
person boxes and keypoints, subject separation in depth (Flicker's `sep`: median inverse depth
gap between subject and surroundings), depth quality, plate available, margins per side,
saliency peaks, aspect ratio relative to output, resolution relative to output, tags, section
energy at the slide's time, slide duration.

**Variety rules**: the same treatment at most twice in a row; alternate the direction of
consecutive pans and orbits; 3D treatments at most `style.depthShare` of slides; accent
treatments (Inflate, Dolly zoom) at most one per section.

**Fill** (when the photo's aspect differs from the output): choose among *Cover* (crop, if every
face fits with headroom), *Pair* (§5.3), *Extend* (outpainted margins, generative fill on, only
on sides the subject does not touch), *Tilt* (pan along the long axis), and *Blur* (a blurred,
darkened copy of the photo behind it, Flicker's letterbox fill, always available).

**Look** (creative style, off by default except in the "Dreamlike" style):
Photo, plus a small pack ported from Flicker's depth looks that keep the photo legible:
*Engraving* (ink lines that wrap the surface), *Topo* (flowing depth contours over the photo;
Flicker's owner's favourite), *Thermal* (colour by depth), *Hologram*. A global *Film* grade
(grain, vignette, slight halation, gentle tone curve) is available on any look.

### 5.7 Pass 7: transitions

| Transition | Use |
|---|---|
| Cut | on beats within a section in Lively and Rapid; the default for flipbooks |
| Crossfade | the general default in Gentle and Balanced |
| Dip to black / white | chapter changes, the end |
| Depth wipe | the next photo arrives far plane first, subject last (Flicker). Good between photos of places. |
| Fly-through | the camera pushes through the subject plane into the next photo waiting behind it (Flicker spec §5.2.1 item 10, never built there) |
| Match cut | consecutive photos with faces: align the main faces (eyes) between the two frames, then cut or crossfade so the face holds its place on screen |
| Push / slide | 2D, in Upbeat only |
| Whip | a fast motion-blurred pan, on strong accents |
| Scan reveal | the next photo appears as its glowing depth map, then a scan plane sweeps it into the photo (Flicker). Creative styles only. |
| Morph | same identity only, opt-in (§1.2) |

Selection: major transitions (dip, fly-through, inflate entry, whip) go on section boundaries
and chapter changes; minor ones (cut, crossfade, depth wipe) inside sections. Transition length
is in beats: ½, 1 or 2 beats depending on tempo and style.

### 5.8 Validation (runs after every plan and every edit)

These are hard constraints; the planner repairs violations, and the editor warns about them.

- **Edge safety**: the camera never shows past the photo's edge (or past its safe margin when
  margins exist) unless the slide's fill is Blur or the user unlocked it. Port Flicker's
  `_border`, `_bounds`, `clamp_view` and `_inside`: project the image border at its own depth
  along the whole camera track; tighten keyframes to fit; if a move would crop below
  `MAX_ZOOM` (0.72) of its framing, scale its amplitude by 0.65 and retry.
- **Face safety**: a face that is the subject stays fully inside the frame at every moment of
  the slide. During a group sweep, faces may enter and leave, but the slide's first or last
  frame contains all faces. Pushes stop before a face would fill more than 60% of the frame
  height.
- **Resolution**: the visible part of the source must not be upscaled more than 1.25× at the
  export resolution. Limit zoom for small images, and warn on low-resolution photos.
- **Motion speed**: cap pan speed (in screen heights per second, per style) and angular speed
  for orbits. Slow pans judder at 24–30 fps; the export offers motion blur (§10.2), and the
  planner prefers 60 fps output for shows heavy in slow pans.
- **Readability**: no slide shorter than 0.4 s except flipbook frames; titles on screen at
  least 2 s plus 0.06 s per character.

### 5.9 Featured person

"Make it about Grandma": pick a face cluster. The planner then raises the rank of slides
containing that person, opens and closes the show on them (the best solo shot and the best
group shot), and prefers face-led treatments for them. Done entirely from identity clusters.

### 5.10 Style presets

Styles are data (JSON), not code, so new styles are easy to add and users can save their own.

```ts
interface Style {
  id: string; name: string;
  pace: { base: number; min: number; max: number };
  treatmentWeights: Record<TreatmentId, number>;
  transitionWeights: { minor: Record<TransitionId, number>; major: Record<TransitionId, number> };
  depthShare: number;        // max share of 3D treatments
  depthAmount: number;       // scales amplitude; Flicker's ds/gain
  generativeFill: 'off' | 'margins' | 'all';
  beatSync: 'off' | 'cuts' | 'cuts+accents';
  look: { default: LookId; mix?: Record<LookId, number> };
  grade?: { film: number };
  titles: { font: string; animation: 'fade' | 'rise' | 'type' };
}
```

| Preset | Character |
|---|---|
| **Classic** | 2D Ken Burns and crossfades only. Safe, timeless. |
| **Gentle** | slow, warm, long crossfades, subtle 3D. For memorials and family. |
| **Cinematic** | strong 3D (arcs, cranes, fly-throughs), film grade, transitions on sections. |
| **Upbeat** | short beats, cuts on beats, whip and push transitions, grid reveals, accents. |
| **Travel** | chapter cards by day and place, establishing shots first, depth pushes into landscapes. |
| **Dreamlike** | creative looks (Topo, Engraving, Hologram) mixed in, scan reveals. |

## 6. Music

### 6.1 Tracks

- Import MP3, AAC/M4A, WAV, FLAC, OGG/Opus (whatever `decodeAudioData` handles [verify per
  browser]).
- A show has an ordered list of songs. Per song: trim in and out, gain, fade in and out.
- Loudness: estimate each song's integrated loudness (K-weighted RMS approximation of LUFS) and
  normalize songs to the same level by default.

### 6.2 Analysis (worker)

Decode, downmix to mono, resample to 22,050 Hz. Then:

1. **Onset strength**: log-mel spectral flux (hop 512, ~23 ms).
2. **Tempo**: tempogram (autocorrelation of onset strength) with a prior centred on 120 BPM;
   report the top two candidates (for the half- and double-tempo ambiguity).
3. **Beats**: dynamic-programming beat tracker (Ellis 2007): maximize onset strength at beats
   plus consistency with the tempo.
4. **Downbeats and bars**: try each phase of 4/4 (and 3/4); pick the phase whose candidate
   downbeats carry the most low-frequency onset energy and the most harmonic change. Optional
   upgrade: the "Beat This!" neural model where available.
5. **Sections**: beat-synchronous chroma and MFCC features, a self-similarity matrix, Foote
   novelty with a checkerboard kernel, peak picking with a minimum length of 8 bars. Cluster
   sections by similarity so repeats get the same label (A, B, A, C…). Snap boundaries to
   downbeats.
6. **Energy curve**: loudness and spectral brightness per beat, smoothed per bar, normalized
   per song. Each section gets an energy level (low, mid, high). Big rises ("drops") are marked
   as accents.
7. **Edges**: leading and trailing silence, fade-out start.

Store the analysis per song hash. The editor shows it, and the user can correct it: shift the
beat grid, halve or double the tempo, drag section boundaries.

**Accuracy target**: tempo within 4% on ≥ 90% of a test set of 30 songs spanning genres; beat
F-measure (±70 ms) ≥ 0.8 on 10 hand-annotated songs (§12). Synthetic click tracks with known
tempos and section changes (timbre switch) are the automated tests.

### 6.3 How the music drives the show

- **Cuts on beats**: every cut lands on a beat (pass 5), major ones on downbeats and sections.
- **Energy → pace**: section energy multiplies desired durations (high 0.75, low 1.3) and moves
  treatment weights (high energy: pushes, whips; low: slow drifts, orbits, focus pulls).
- **Motion lands on the beat**: a move's ease-out completes on a downbeat, where the slide
  lasts long enough for that.
- **Accents** (`cuts+accents` only): a 2–3% zoom pulse on strong downbeats, a whip on a drop, an
  Inflate at the first beat of a high section.
- **The ending**: the last slide holds through the final note; the fade to black follows the
  song's fade.

### 6.4 Several songs

- **Crossfade** between songs (default 4 s, equal-power), placed so song A's last section (or
  outro) overlaps song B's intro.
- If the tempos are within 6%, align song B's first downbeat with one of song A's during the
  crossfade. No time-stretching in v1.
- A song change counts as a section boundary, so a major transition goes there.
- With *Fit show to music*, the show's length is the sum of songs minus crossfades.

### 6.5 Mixing with video audio

- Each video clip's audio has a level (default: on for clips with speech, off otherwise).
- **Ducking**: under clips with speech, the music drops by 12 dB (attack 300 ms, release
  800 ms). Under clip audio without speech, it drops by 6 dB.
- The mix is described in the timeline (§8) and rendered identically in preview (Web Audio
  graph) and export (`OfflineAudioContext`).

## 7. Video clips

- **Highlight picking**: for each video, score 0.5 s windows by faces (count and size),
  motion energy (in range: moving, not chaotic), steadiness (low shake), sharpness, and speech
  (do not cut mid-sentence: snap edges to VAD pauses). Choose the best window of the target
  length (style-based, 2–6 s; longer when speech is present), snapped to beats in pass 5.
- The user can trim in the inspector (a filmstrip of the clip with the chosen range).
- Speed: 1× by default. Clips recorded at ≥ 60 fps can play at 0.5× as an accent on low-energy
  sections.
- Video frames are not depth-analysed in v1. Treatments for clips: none, or a gentle 2D push.
- Preview uses `<video>` elements as textures (`requestVideoFrameCallback`), pre-seeked before
  the slide starts. Export decodes frame-accurately with WebCodecs.
- Portrait video in a landscape show uses the Blur fill.

## 8. Data model and the render contract

### 8.1 Storage

```text
IndexedDB "lantern"
  projects   { id, title, created, updated, json: Project }
  media      { hash, kind, name, w, h, duration?, taken?, gps?, handle?, opfs: {...}, flags }
  analysis   { hash, stage, model, params, version, status, result JSON | opfs path }
  people     { id, name?, faceIds[], cover }
  songs      { hash, name, duration, analysis }
OPFS
  /m/<hash>/thumb.webp  proxy.webp  depth.u16.gz  matte.u8.gz  plate.webp  platedepth.u16.gz  plate.json
  /exports/<id>.mp4     (browsers without a save picker)
```

Canvas cannot encode 16-bit PNG, so depth is stored as raw `Uint16Array`, gzipped with
`CompressionStream`. Request persistent storage (`navigator.storage.persist()`) and show usage
and quota in Settings, with "Clear analysis cache" per project and globally.

**Project files**: export and import a `.lantern` package (a zip): the project JSON, optionally
the analysis cache (moves a project between machines without re-analysis), and optionally the
media itself ("Package with media").

### 8.2 Project

```ts
interface Project {
  v: 1;
  id: string; title: string; seed: number;
  output: { aspect: '16:9' | '9:16' | '1:1' | '4:5' | '21:9'; height: 720 | 1080 | 1440 | 2160; fps: 24 | 30 | 60 };
  styleId: string; styleOverrides: Partial<Style>;
  media: string[];                    // content hashes, in user order
  excluded: string[]; starred: string[];
  featuredPerson?: string;
  order: 'time' | 'story' | 'manual' | 'shuffle';
  songs: SongRef[];                   // { hash, trimIn, trimOut, gain, fadeIn, fadeOut }
  fit: 'show-to-music' | 'music-to-show' | 'free';
  slides: Slide[];                    // the planned and edited show
  history?: never;                    // undo stack lives in memory, not in the project
}

interface Slide {
  id: string;
  kind: 'photo' | 'video' | 'pair' | 'grid' | 'flipbook' | 'title';
  items: string[];                    // media hashes
  start: number; dur: number;         // seconds on the show clock
  treatment: Treatment;               // §9.1 camera keys etc.
  fill: 'cover' | 'pair' | 'extend' | 'tilt' | 'blur';
  look: LookId; grade?: number;
  transitionIn: { type: TransitionId; dur: number };
  caption?: Caption;
  clip?: { in: number; out: number; speed: number; gain: number };
  locks: Partial<Record<'items' | 'position' | 'dur' | 'treatment' | 'fill' | 'look' | 'transition' | 'caption', true>>;
  auto: { reasons: string[]; alternates: Treatment[]; quality: 'draft' | 'full' };
}
```

**Locks**: any user edit to a field locks it (the UI shows a small padlock you can click to
unlock). Re-planning ("Re-roll", a new song, a style change) rewrites only unlocked fields.
`position` locks a slide's place in the order; `dur` locks its length (pass 5 treats it as
fixed).

### 8.3 Timeline (render contract)

The renderer never reads `Project`. A compile step (`compile(project, analysis) → Timeline`)
resolves everything to plain numbers: camera keys in absolute show time, asset references,
transition windows and audio events. It is versioned (`v`) and covered by golden tests.

```ts
interface Timeline {
  v: 1; dur: number; fps: number; size: [number, number];
  layers: RenderSlide[];              // sorted by start; overlapping during transitions
  audio: AudioEvent[];                // { src, at, in, out, gain: Envelope, duck?: Envelope }
  captions: CaptionEvent[];
}

interface RenderSlide {
  id: string; t0: number; t1: number;
  assets: { image?: AssetRef; maps?: AssetRef; plate?: AssetRef; video?: AssetRef };
  // Camera model, Flicker stills.py: keys and focus are separate tracks, eased per segment.
  keys: { t: number; view: [number, number, number]; cam: [number, number, number]; f: number; ds: number }[];
  focus?: { t: number; d: number; amt: number }[];
  aim?: [number, number]; k?: number; border?: Border; ext?: [number, number, number, number];
  look: number; fill: number; grade: number;
  enter?: { type: TransitionId; t0: number; t1: number; params?: Record<string, number> };
  cells?: { rect: [number, number, number, number]; slide: RenderSlide }[]; // pair/grid
}
```

## 9. Renderer

### 9.1 Camera model

Port Flicker's Living Stills camera unchanged (docstring of `planner/stills.py`, functions
`aim_rotation` and `project`, and `aimRotation` / `liveBounds` / `clampView` in
`client/src/lib/stills.ts`):

- Coordinates are normalized to image height and centred: u = (x − w/2) / h, v = (y − h/2) / h.
- Depth d is inverse depth (1 = near). Each key scales depth about the pivot:
  d′ = dp + ds (d − dp), so ds = 0 is the flat photo and ds = 1 the measured depth.
- Distance Z = 1 / (Z_FAR + (1 − Z_FAR) d′), with Z_FAR = 0.25 (a 4:1 depth range).
- The camera at C with focal scale f turns to aim at the subject's 3D aim point (look-at with
  blend k: k = 0 is a plain camera move, k = 1 an orbit that keeps the aim point fixed).
- `view` [vx, vy, vs] frames the projected image for the output aspect.
- 2D Ken Burns is the same model with ds = 0, so all motion shares one code path, one easing
  system and one edge-safety check.

Flicker checked its Python and TypeScript implementations against each other to about 1e-16.
In Lantern the planner also moves to TypeScript, so keep Flicker's Python as the reference: a
one-off parity script, not a shipped test.

### 9.2 Layers and drawing

- Two depth-displaced grid meshes per slide (subject and background), 128 × 128 on desktop, 64
  × 64 on lite. This is Flicker's `stills.ts`.
- Subject alpha = matte grown and feathered, so a still frame equals the photo exactly. It
  blends to the tight matte as the camera moves away from rest (Flicker: 0.015–0.065), which
  removes the halo of background carried on the subject.
- Background = the plate (generative) or push-pull fill (classical), with its own depth, and
  margins past the frame that fade into the letterbox over their outer part.
- Depth of field: Flicker used mip-bias blur, which gets blocky at high levels. Lantern should
  build the few-tap disc blur (Flicker spec §5.2.1 item 9) from the start.
- Letterbox fill: a blurred, darkened copy of the slide (Flicker `gl.ts`).
- Transitions render both slides into offscreen framebuffers and combine them in a transition
  shader, except depth-aware ones (depth wipe, fly-through, scan) that need both slides' depth.
- Captions and titles: text drawn with Canvas 2D into textures, composited last. Fonts are
  bundled (OFL-licensed), never fetched at runtime.
- Performance: 60 fps preview on Full tier; never below 30 on Standard. Preload a window of
  slides around the playhead (3 ahead and 1 behind; Flicker preloaded 3 ahead), with a texture
  memory budget per tier. When frame time slips, lower mesh density, then turn off DOF.

### 9.3 Determinism

- No wall clock, no `Math.random` in drawing. Any animated noise (film grain, flicker in looks)
  is a function of show time and slide id.
- The preview may skip frames; the export renders every frame at exactly `n / fps`.
- A preview frame and an export frame at the same `t` must match within a small per-pixel
  tolerance (golden test, §12).

## 10. Export

### 10.1 Settings

- Resolution 720p, 1080p (default), 1440p, 4K (Full tier, with originals available); the
  project's aspect ratio; 24, 30 or 60 fps.
- Format: MP4 with H.264 and AAC by default. If AAC encode is unavailable, MP4 with Opus or
  WebM with VP9 and Opus. HEVC or AV1 where `isConfigSupported` says yes. Check every codec
  with `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported` at runtime, and say
  which was chosen.
- Quality: a bitrate preset (Standard, High, Max).
- Motion blur: render 4 sub-frames per frame and average them (off, or on for slow-pan styles).
- Burned-in captions (always: they are part of the show).

### 10.2 Pipeline

1. Make sure every slide has its analysis (with a progress bar), or let the user export with
   draft slides.
2. Render in a worker: `OffscreenCanvas` with WebGL2, a fixed timestep, `new VideoFrame(canvas,
   { timestamp })`, then `VideoEncoder`. Apply backpressure on `encodeQueueSize` so memory
   stays flat.
3. Mix audio in an `OfflineAudioContext` from the timeline's audio events (songs, fades,
   crossfades, clip audio, ducking), then `AudioEncoder`.
4. Mux with Mediabunny and stream the output to a `FileSystemWritableFileStream` (Chromium) or
   to OPFS, then download.
5. Hold a Wake Lock. Show progress, ETA and Cancel. Warn that a hidden tab may slow the export.

Fallback if WebCodecs encode is missing: real-time capture with `MediaRecorder` from a canvas
stream, labelled "real-time export (slower, lower quality)".

**Targets** [verify in M0]: a 3-minute 1080p30 show in under 3 minutes on a desktop with a
discrete GPU; under 6 minutes on a 2023 laptop with integrated graphics. Audio and video in sync
within one frame (tested, §12).

Also exportable: the current frame as a JPEG, and the project package (§8.1).

## 11. The app (UI)

### 11.1 Flow

1. **Start**: "New show" (drop photos, videos and songs; or pick a folder), recent projects, and
   a "Try the demo" project with bundled CC0 photos and music.
2. **Make**: one screen with three choices and a big button: style (cards with a looping
   preview), music (drop songs or "no music"), aspect ratio. **Make my show** plans immediately
   from fast analysis and opens the editor playing it. Depth arrives in the background.
3. **Editor** (the main screen, §11.2).
4. **Export** (a dialog, §10).

### 11.2 Editor

```text
┌──────────────────────────────────────────────────────────┬───────────────────┐
│                                                          │ Inspector         │
│                     Preview player                       │  (slide, song or  │
│        (play/pause, scrub, full screen, draft badge)     │   show settings)  │
│                                                          │                   │
├──────────────────────────────────────────────────────────┴───────────────────┤
│ Storyboard ▸ ▢▢▢▢▢▢▢▢▢▢▢▢▢▢   (toggle)   Timeline ▸ slides ∣ music waveform    │
│   with beat ticks, section bands coloured by energy, transitions between blocks│
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Storyboard**: slide cards in order with thumbnails, duration, treatment icon, lock icons and
  analysis dots. Drag to reorder, multi-select, and batch-apply duration, treatment, transition
  or look.
- **Timeline**: time-proportional slide blocks over the song waveform with beat ticks, bar
  numbers and section bands. Drag a block edge to change a duration (ripple; snaps to beats
  when beat sync is on; Alt to snap freely). Transition handles between blocks set the
  transition length. Drag a section boundary or the beat grid to correct the analysis.
- **Library drawer**: all imported media, with People, Moments and quality filters; drag items
  into the storyboard; suggested-out items shown dimmed with the reason.
- **Inspector, slide**:
  - Media: replace, rotate 90°, crop the source rectangle, choose a burst alternate.
  - Duration: in seconds or beats; lock.
  - Motion: *Auto* or any treatment; *Amount* slider; direction; **Edit framing**, an overlay on
    the photo with start and end rectangles to drag (and tour stops); *3D amount* (depth scale)
    for depth treatments; *Focus* point (click in the photo).
  - Fill: Cover, Pair, Extend, Tilt or Blur, with "Show generated pixels".
  - Look and grade. Transition in. Caption (text, position, style, timing). Clip trim and gain
    for videos.
  - **Try another**: cycles the planner's alternates. **Why?**: the planner's reasons.
- **Inspector, show**: style, pace, order mode, featured person, beat sync, fit mode, 3D
  strength, generative fill, intro and end titles, output format.
- **Inspector, song**: trim, gain, fades, crossfade length to the next song, tempo correction.
- **Re-roll** (show-level): re-plans every unlocked choice with a new seed.
- **Upgrades after editing**: before the user's first edit, slides upgrade to 3D automatically
  as depth arrives. After it, Lantern offers the upgrade instead ("3D is ready for 42 slides:
  Apply"), so nothing changes under the user's hands.
- Undo and redo (a command stack covering every edit, including re-rolls), autosave to
  IndexedDB, keyboard shortcuts (Space, J/K/L, ←/→, Delete, Ctrl+Z / Ctrl+Shift+Z, L to lock).
- Port Flicker's sheet, segmented control, toggle and hint components (`client/src/ui/`).
- Phones: the editor collapses to a vertical layout (preview, storyboard, inspector as a bottom
  sheet). The timeline is desktop-only in v1.

### 11.3 Trust and transparency

- A short line on the start screen and in Settings: "Your photos never leave this device."
- A Settings page listing every model, its size, license and whether it is downloaded, with
  delete buttons.
- No analytics, no third-party scripts. A strict CSP (`default-src 'self'`, `connect-src`
  limited to the model host).

## 12. Testing

- **No real personal photos in the repo.** Use synthetic images (shapes, gradients, rendered
  scenes with known depth), and a small set of CC0 photos for model smoke tests (with faces,
  groups, landscapes; source and license recorded per file).
- **Planner and DSP (Vitest)**: analysis results are injected as fixture JSON, so these tests
  don't run models. Cover: duration multipliers, the music-fit DP (exact end, beat snapping,
  bounds, locks respected), treatment choice and variety rules, edge safety (sampled over every
  track: no edge reveal, the property Flicker checked in simulation), face safety, determinism
  (same seed → identical timeline), re-plan respects every lock.
- **Audio**: synthetic click tracks at known tempos with timbre changes at known section times;
  assert tempo, beat positions within ±20 ms and section boundaries within one bar.
- **Golden frames (Playwright)**: render fixed timelines through the preview path and the export
  path and compare per-pixel within tolerance. Read canvas pixels inside a
  `requestAnimationFrame` callback (Flicker learned that the canvas drops its pixels once a frame
  is shown), and do not average alpha into "something is drawn" checks (it is always 255).
- **Export round trip**: export a 10 s synthetic show, decode it with Mediabunny in the test,
  and check duration, frame count, resolution and that audio exists. A sync test: a white flash
  frame at each beat and a click in the audio at the same times; measured offset must stay
  under one frame.
- **Storage**: import 1,000 synthetic images; reload; projects and analysis restore.
- **Browser matrix in CI**: Chromium (full), Firefox and WebKit (Playwright) for the standard
  tier paths, with the model and encoder availability actually detected.

## 13. Milestones

Each milestone ends with something a person can try on the deployed Pages site.

| # | Milestone | Done when |
|---|---|---|
| **M0** | **Feasibility spikes** | A bench page runs every model candidate (§4.3) in Chrome, Firefox and Safari on WebGPU and WASM, with ms per image, peak memory and a good / usable / wrong review page (port Flicker's `bench` idea). An export spike writes 60 s of WebGL with AAC to MP4 that plays in QuickTime, VLC and on phones. A Pages spike proves cross-origin isolation via the service worker plus CORS model fetches. A beat-tracking spike measures accuracy (§6.2). Results recorded in the spec, with model picks adopted. |
| **M1** | **Import, library, 2D show** | Import, basics, faces and CLIP; library with duplicates and quality flags; planner passes 1–4 and 6 with 2D treatments only (push, pan, group sweep, tour, hold); crossfades and cuts; preview player. |
| **M2** | **Music** | Song import, analysis, editor display and correction; music fit (pass 5); several songs with crossfades; mix in preview. |
| **M3** | **Editor** | Storyboard, timeline, inspector, framing editor, locks, alternates, re-roll, undo, autosave, project packages. |
| **M4** | **Export** | The export pipeline, codec fallbacks, progress, golden-frame and sync tests. |
| **M5** | **Depth Space** | Depth and matte stages, two-layer meshes, depth treatments, depth wipe, fly-through, disc DOF, upgrade-in-place. |
| **M6** | **Fills** | Plates, margins, person guard, Extend fill, pairs and grids, "show generated pixels". |
| **M7** | **Video** | Video scan, highlight picking, clip slides, ducking, frame-accurate export decode. |
| **M8** | **Polish** | People and featured person, chapters and titles, all style presets, creative looks, flipbooks, PWA offline, mobile layout, accessibility pass. |

### 13.1 M0 results (2026-11-10, first build session)

Measured on Linux with Playwright's headless Chromium 158 (SwiftShader GL, software H.264), so
timings are a floor, not typical hardware. Verified items are marked; the rest of the **[verify]**
list stays open.

| Spike | Result |
|---|---|
| Face detection | MediaPipe Face Detector (short range, Apache-2.0, 230 KB, SHA-256 pinned in `src/lib/models/registry.ts`) runs in the analysis worker with a tiled second pass; 23 of 23 test photos analysed, 8 faces found in a 8-person group shot. **Caveat:** MediaPipe loads its WASM glue with `importScripts`, so the worker must be a classic (iife) worker; Vite's dev server forces module workers, where Lantern falls back to the main thread. CORS from `storage.googleapis.com` is fine; weights should still move to a project-owned Hugging Face repo (§2.1), and the CSP currently allows both hosts. |
| Beat tracking | Classical DSP (log-mel flux → tempogram → Ellis DP → downbeat phase → Foote sections) on a 128 BPM click track: tempo within 0.4 %, > 85 % of beats within 20 ms after calibrating the onset frame to the window tail, section boundary within one bar of a timbre change. 60 s of audio analyses in well under a second in a worker. Real-song accuracy (§6.2 targets) is **not yet measured**. |
| Renderer | Single WebGL2 path for preview and export (`src/lib/render/renderer.ts`): depth-displaced mesh with a flat stand-in map, letterbox fill, crossfade / dip / push / whip in a composite pass, captions, film grade. 13–23 fps on SwiftShader at 1080p-class canvas; needs measuring on a GPU. |
| Export | WebCodecs via Mediabunny: a 24 s 1080p30 show → MP4 (H.264 + Opus, 17 MB) in 82 s on software encode; ffprobe reports 720 frames, 24.000 s, both streams present. AAC was not available in headless Chromium (Opus in MP4 was chosen automatically). Save picker streaming works in Chromium; a download fallback exists. **Not yet tested:** QuickTime/VLC/phone playback, A/V sync measurement, Firefox and Safari. |
| Pages isolation | The service worker (`public/sw.js`) adds COOP/COEP (`credentialless`) and caches the app shell; the app reloads once after first activation. The WASM path is single-threaded without it. **Not yet verified on the deployed site** (nothing is deployed yet). |
| OPFS and IndexedDB | Proxies (2560 px), analysis images (1024 px) and thumbnails (320 px) in OPFS, records and analysis in IndexedDB, originals kept in IndexedDB when no directory handle exists. Import of 23 photos plus a song and the full plan completes in about 10 s in the headless run. |

Decisions adopted from M0: MediaPipe Face Detector as the face model; classical DSP as the default
beat tracker; Mediabunny for muxing (its API matched the spec's assumptions); classic workers.

## 14. Porting map from Flicker

Read these Flicker files (under `/mnt/Secondary/Projects/Code/Flicker`) for their algorithms. Port the logic; rewrite names, comments and tests
for Lantern; drop everything listed under "leave behind".

| Flicker source | Take | Leave behind |
|---|---|---|
| `src/flicker/planner/stills.py` | the camera model, `choreograph` and `_layout` (move shapes and amplitudes), `_border`, `_bounds`, `clamp_view`, `_inside`, `aim_rotation`, `project`, figure separation as an amplitude control, tour stops | NudeNet regions as tour stops (`TOUR_SKIP`, `_spot`); embedding-neighbourhood "next photo" (Lantern orders by its own passes) |
| `client/src/lib/stills.ts` | two-layer meshes, `aimRotation`, `liveBounds`, `clampView`, tight-alpha blend, DOF, depth wipe, scan reveal, crossfade via FBO, Topo / Engraving / Thermal / Hologram shaders, `Renderer.zoom` | breath (it warps the body), Slice, Pulse, Blinds, Projector, Splats and Scatter, stereo, look-around and tilt (Lantern is a video, not a toy) |
| `client/src/lib/gl.ts`, `lib/delaunay.ts` | blurred letterbox fill, mesh warp (for same-person morphs), `rect` and scissoring for pairs and grids | Pose Flow specifics |
| `src/flicker/layers.py` | grown and feathered subject alpha, push-pull fill, plate composition, relief and normal maps | — |
| `src/flicker/analyzers/inpaint.py`, `PlateStage` | hole construction, mirrored context and mask, plate depth fit, margins on open sides, windowed outpainting, the person guard | — |
| `src/flicker/stages/base.py` | versioned, resumable stages with `requires`, out-of-memory back-off | the GPU-per-process assumptions |
| `src/flicker/ingest.py` | xxh3 identity, pHash with complete-linkage grouping, proxy sizes | inotify watching, the folder exclusion feature |
| `src/flicker/planner/poseflow.py` (`Aligner`), `pose/normalize.py` | similarity fit with spread-ratio scale, low-pass target and size governor: for flipbook stabilization and match cuts | the pose graph, wander, journeys, presets |
| `src/flicker/planner/collide.py` | Chorus cell tiling (for grids), the Split seam idea | lanes, ghost, stages |
| `src/flicker/stages/analysis.py` (face clustering) | clustering approach for People | SCRFD + ArcFace weights (non-commercial license) |
| `src/flicker/bench/` | the bench and review-page workflow for M0 | — |
| `client/src/ui/` | `Sheet`, `Seg`, `Toggle`, `Chrome`, `Hint` | — |
| `src/flicker/models.py` | pinned SHA-256 fetch, rejecting HTML responses | — |
| everything else (`server/`, `auth`, `privacy`, `Collide`, `Player`, NudeNet, presets, LAN, PIN, panic) | nothing | all |

## 15. Open questions for the owner

1. **Name.** "Lantern" is chosen (owner, 2026-11-10). Check for clashes before publishing.
2. **License for Lantern's own code.** MIT or Apache-2.0 would match the model choices. (Using
   Essentia.js for audio would force AGPL, which is one reason this spec writes its own DSP.)
3. **Demo content.** Which CC0 photos and music to bundle for the demo project and tests.
4. **Hosting of model weights.** A Hugging Face repo under whose account?
5. **Phones.** Is creating shows on a phone a goal for v1, or is the phone tier playback and
   light editing only?
6. **Generative fill default.** On by default in Cinematic and Travel styles (margins only), or
   off everywhere until the user opts in?
7. **Reverse geocoding.** Chapter cards could name places ("Lisbon") with an offline city list
  (a few MB). Worth it for v1, or dates only?
8. **Sharing without a file.** A later "play this show in the browser" link would need hosting
  the media somewhere, which breaks local-only. Keep it out?
