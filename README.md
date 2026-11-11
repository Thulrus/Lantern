# Lantern

**Slideshows that build themselves, from your photos, videos and music, entirely in your browser.**

Lantern looks at every picture to find faces, groups, depth and the main subject, then listens to
your songs for beats and sections. It plans the whole show from that:

- a slow push-in toward a single face, a pan across a group photo, and longer holds where there's
  more to see;
- photos that turn into small 3D scenes, with the camera moving through real parallax;
- cuts that land on the beat, and big transitions where the song changes section;
- several songs with crossfades, and the music lowered under video clips where people talk.

Then you can change anything: order, durations, camera moves, framing, transitions, captions. When
it's ready, export it as a video file.

**Your photos never leave your device.** There's no account, no upload and no server. Lantern is a
static web page; all analysis, rendering and video encoding runs locally in your browser.

> **Status:** early development. The first vertical slice works: import photos and songs, the
> automatic 2D director with beat-synced cuts, the editor and MP4 export. Depth Space (3D),
> generative fills and video clips are next. See [`lantern-spec.md`](lantern-spec.md) for the plan
> and [`docs/HANDOFF.md`](docs/HANDOFF.md) for progress.

## Browser support (planned)

Best in a recent Chromium browser (Chrome, Edge) on a desktop or laptop with WebGPU. Firefox and
Safari will work with fewer features and slower analysis. Phones can play and lightly edit shows.

## Development

```sh
npm install
npm run dev        # dev server
npm test           # unit tests (planner, music DSP, camera model)
npm run check      # type check
npm run e2e        # Playwright end-to-end (Chromium)
npm run build      # static build in dist/
```

TypeScript, Svelte 5 and Vite, with WebGL2 rendering, MediaPipe and ONNX Runtime Web for the
models and WebCodecs (via Mediabunny) for export. Deploys to GitHub Pages from `main`.

## License

To be decided (MIT or Apache-2.0).
