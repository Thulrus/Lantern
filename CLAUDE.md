# Lantern: agent notes

A public, browser-only slideshow creator: it analyses photos, videos and songs locally and plans
a show that the user can edit and export to video. Hosted on GitHub Pages.

**Read `lantern-spec.md` (the product spec) and `docs/HANDOFF.md` (current status, next steps)
before starting work. Keep `docs/HANDOFF.md` up to date at the end of every session.**

## Hard rules

- **Everything runs on the user's device.** No uploads, analytics, third-party scripts or runtime
  fetches except the app itself and pinned, checksummed model weights (spec §2.1, §11.3).
- **Never alter the person** (spec §1.2). People's pixels come only from the source, changed by
  geometric moves, blends, masks and global colour math. Generative fill only outside people,
  always behind the person guard. No body warps, face retouching or upscaling of people. Morphs
  only between photos of the same person, opt-in.
- **Permissive licenses only** for code, models and assets: no non-commercial weights (e.g.
  InsightFace SCRFD/ArcFace, RMBG, Depth Anything V2 Base/Large), no AGPL/GPL dependencies
  unless the owner agrees. Record the license of every model and bundled asset.
- **Flicker** (`/mnt/Secondary/Projects/Code/Flicker`) is a private sibling project that Lantern
  ports algorithms from (spec §14).
  - Read its source code only. Never open its data directory, photo collection or anything under
    `/media/veracrypt1`.
  - Never copy Flicker files, docs, fixtures or comments into this repo wholesale. Rewrite them
    for Lantern.
  - Lantern must not mention Flicker's subject matter anywhere: no NudeNet, body-region labels
    or pose presets.
- **No real personal photos in the repo.** Tests use synthetic images and CC0 samples whose
  source and license are recorded (spec §12).
- Items the spec marks **[verify]** are unconfirmed. Check them (milestone M0) before building on
  them, and update the spec with what you found.
- Commit or push only when the owner asks.

## Where to start

Read `docs/HANDOFF.md` for the current state. The code lives in `src/lib` (planner, audio DSP,
analysis, media, render, export, store), `src/app` (Svelte screens) and `src/workers`.

## Commands

- `npm install` once; `npm run dev` for the dev server (copies WASM runtimes into `public/vendor` first).
- `npm run check` (svelte-check, strict TS), `npm test` (Vitest: planner, DSP, camera), `npm run e2e`
  (Playwright, Chromium; imports `example_photos/` when that local folder exists).
- `npm run build` → `dist/`; GitHub Pages deploys from `.github/workflows/deploy.yml` on push to main.
- `#/bench` in the running app is the M0 bench page; `#/settings` lists models and storage.
