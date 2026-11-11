<script lang="ts">
  // M0 bench page (spec §13): capability detection, model download and timing, a renderer and
  // export spike, and a beat-tracking spike on a synthetic click track. Results are shown as a
  // table to copy into the spec.
  import { onMount } from "svelte";
  import { detect, type Capabilities } from "$lib/media/tier";
  import { MODELS } from "$lib/models/registry";
  import { fetchModel } from "$lib/models/fetch";
  import { loadFaceDetector, detectFaces } from "$lib/analysis/faces";
  import { DEPTH_EDGE_FULL, DEPTH_MODEL, estimateDepth, loadDepth } from "$lib/analysis/depth";
  import { depthStats, normalizeDepth, reliefOf } from "$lib/analysis/depthmath";
  import { analyzeMusic, SR } from "$lib/audio/analyze";
  import { Renderer } from "$lib/render/renderer";
  import { exportCapabilities, exportVideo } from "$lib/export/export";
  import type { Timeline } from "$lib/planner/types";
  import { BASE } from "$lib/store/project.svelte";
  import { fmtBytes } from "$lib/util/math";
  let caps = $state<Capabilities | null>(null);
  let rows = $state<{ test: string; result: string; ms?: number }[]>([]);
  let busy = $state<string | null>(null);
  let canvas: HTMLCanvasElement;
  onMount(async () => { caps = await detect(); });
  const add = (test: string, result: string, ms?: number) => (rows = [...rows, { test, result, ms }]);

  async function benchFaces() {
    busy = "faces";
    try {
      const t0 = performance.now();
      await fetchModel("mp-face-short");
      add("face model download + verify", "ok", performance.now() - t0);
      const t1 = performance.now();
      const det = await loadFaceDetector(BASE);
      add("face detector init", "ok", performance.now() - t1);
      // A synthetic image: no faces expected, but it times the pass.
      const c = new OffscreenCanvas(1024, 768);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#789"; ctx.fillRect(0, 0, 1024, 768);
      for (let i = 0; i < 5; i++) { const t = performance.now(); await detectFaces(det, c, 4); if (i === 4) add("faces on 1024 px synthetic (1 + tiles)", "ran", performance.now() - t); }
    } catch (e) { add("faces", "error: " + (e instanceof Error ? e.message : String(e))); }
    busy = null;
  }
  async function benchDepth() {
    busy = "depth";
    try {
      const t0 = performance.now();
      await fetchModel(DEPTH_MODEL);
      add("depth model download + verify", "ok", performance.now() - t0);
      const t1 = performance.now();
      const s = await loadDepth(BASE);
      add("depth session init (wasm)", `ok, threads ${crossOriginIsolated ? "on" : "off (not isolated)"}`, performance.now() - t1);
      // A synthetic scene: a bright disc "subject" on a darker gradient "room" with a floor line.
      const img = benchImage(1);
      const ctx = img.getContext("2d")!;
      ctx.fillStyle = "#eee"; ctx.beginPath(); ctx.ellipse(960, 640, 220, 380, 0, 0, 7); ctx.fill();
      let r = await estimateDepth(s, img, DEPTH_EDGE_FULL);
      add("depth warm-up (1920×1080 → short edge 518)", `${r.w}×${r.h}`, performance.now() - t1);
      const t2 = performance.now();
      r = await estimateDepth(s, img, DEPTH_EDGE_FULL);
      const ms = performance.now() - t2;
      const norm = normalizeDepth(r.raw);
      const st = depthStats(norm.u16, r.w, r.h, { lo: norm.lo, hi: norm.hi, cv: reliefOf(r.raw) }, [740, 260, 1180, 1020], 1920, 1080);
      add("depth inference, second run", `sep ${st.sep.toFixed(3)}, pivot ${st.pivot.toFixed(2)}, quality ${st.quality.toFixed(2)}, raw ${st.range[0].toFixed(2)}..${st.range[1].toFixed(2)}`, ms);
      // Show the map.
      const c = canvas.getContext("2d")!, im = c.createImageData(r.w, r.h);
      for (let i = 0; i < norm.u16.length; i++) { const v = norm.u16[i] >> 8; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
      const o = new OffscreenCanvas(r.w, r.h); o.getContext("2d")!.putImageData(im, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(o, 0, 0, canvas.width, canvas.height);
    } catch (e) { add("depth", "error: " + (e instanceof Error ? e.message : String(e))); }
    busy = null;
  }
  async function benchBeats() {
    busy = "beats";
    const bpm = 128, n = 60 * SR, x = new Float32Array(n), period = (60 / bpm) * SR;
    let s = 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let b = 0; b * period < n; b++) { const st = Math.round(b * period); for (let i = 0; i < 1200 && st + i < n; i++) x[st + i] += (b % 4 === 0 ? 1 : 0.5) * rnd() * Math.exp(-i / 250); }
    for (let i = 0; i < n; i++) x[i] += (i / SR < 30 ? Math.sin(2 * Math.PI * 220 * (i / SR)) : Math.sin(2 * Math.PI * 110 * (i / SR))) * 0.15;
    const t0 = performance.now();
    const a = analyzeMusic([x], SR);
    const ms = performance.now() - t0;
    const hits = a.beats.filter((b) => Math.abs(b - Math.round(b / (60 / bpm)) * (60 / bpm)) < 0.02).length;
    add("beat tracking, 60 s click track at 128 BPM", `tempo ${a.tempo.toFixed(1)}, ${hits}/${a.beats.length} beats within 20 ms, ${a.sections.length} sections (change at ${a.sections[1]?.start.toFixed(1) ?? "?"} s, true 30 s)`, ms);
    busy = null;
  }
  function syntheticTimeline(dur: number): Timeline {
    const layers: Timeline["layers"] = [];
    const n = 6, each = dur / n;
    for (let i = 0; i < n; i++) layers.push({ id: "b" + i, t0: i * each, t1: (i + 1) * each + (i < n - 1 ? 0.5 : 0), w: 1920, h: 1080, assets: { image: { hash: "bench" + (i % 2), kind: "image" } }, keys: [{ t: 0, view: [0, 0, 1], cam: [0, 0, 0], f: 1, ds: 0 }, { t: 1, view: [0.1 * (i % 2 ? 1 : -1), 0, 0.8], cam: [0, 0, 0], f: 1, ds: 0 }], fill: 0, enter: i ? { type: "crossfade", t0: i * each, t1: i * each + 0.5 } : undefined, cover: [true, true], bounds: [-8 / 9, 8 / 9, -0.5, 0.5] });
    return { v: 1, dur, fps: 30, size: [1280, 720], aspect: 16 / 9, layers, audio: [], captions: [{ t0: 0, t1: 3, text: "Lantern export spike", position: "bottom", style: "plain", slideId: "b0" }], beats: [] };
  }
  function benchImage(seed: number): OffscreenCanvas {
    const c = new OffscreenCanvas(1920, 1080), ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 1920, 1080); g.addColorStop(0, seed ? "#2b4a7a" : "#7a3b2b"); g.addColorStop(1, "#111");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${(i * 37 + seed * 90) % 360} 60% 55%)`; ctx.beginPath(); ctx.arc((i * 331) % 1920, (i * 173) % 1080, 20 + (i % 7) * 12, 0, 7); ctx.fill(); }
    return c;
  }
  async function benchRender() {
    busy = "render";
    try {
      canvas.width = 1280; canvas.height = 720;
      const r = new Renderer(canvas);
      r.upload("bench0", benchImage(0)); r.upload("bench1", benchImage(1));
      const tl = syntheticTimeline(12);
      const t0 = performance.now();
      const N = 240;
      for (let i = 0; i < N; i++) r.draw(tl, (i / N) * tl.dur);
      r.gl.finish();
      const ms = (performance.now() - t0) / N;
      add("preview render 1280×720, 2D move + crossfade", `${(1000 / ms).toFixed(0)} fps`, ms);
      r.dispose();
    } catch (e) { add("render", "error: " + String(e)); }
    busy = null;
  }
  async function benchExport() {
    busy = "export";
    try {
      const ec = await exportCapabilities(1280, 720);
      add("export codecs", ec.webcodecs ? `${ec.video?.codec ?? "none"} / ${ec.audio ?? "no audio"} in ${ec.video?.container ?? "?"}` : "no WebCodecs");
      if (!ec.webcodecs || !ec.video) return;
      const tl = syntheticTimeline(10);
      // Bench images live only in memory: give the exporter textures by pre-registering them.
      const t0 = performance.now();
      const r = await exportVideo(tl, { quality: "high", motionBlur: false, fileName: "lantern-export-spike" }, () => {});
      add("export 10 s 720p30 (synthetic, placeholder frames)", `${r.codec} → ${r.fileName} ${fmtBytes(r.bytes)}`, performance.now() - t0);
    } catch (e) { add("export", "error: " + (e instanceof Error ? e.message : String(e))); }
    busy = null;
  }
  const table = $derived(rows.map((r) => `| ${r.test} | ${r.result} | ${r.ms !== undefined ? r.ms.toFixed(0) + " ms" : ""} |`).join("\n"));
</script>

<div class="page">
  <header class="row"><a href="#/">◐ Lantern</a><span class="dim">›</span><h2>Bench</h2></header>
  {#if caps}
    <div class="card">
      <h3>Capabilities</h3>
      <p>{navigator.userAgent}</p>
      <p>tier <b>{caps.tier}</b> · WebGPU {caps.webgpu ? "✓" : "✗"} · WebGL2 {caps.webgl2 ? "✓" : "✗"} · WebCodecs {caps.webcodecs ? "✓" : "✗"} · OPFS {caps.opfs ? "✓" : "✗"} · crossOriginIsolated {caps.isolated ? "✓" : "✗"} · File System Access {caps.fsAccess ? "✓" : "✗"} · {caps.threads} threads · ~{caps.memory} GB · wake lock {caps.wakeLock ? "✓" : "✗"}</p>
    </div>
  {/if}
  <div class="row">
    <button onclick={benchFaces} disabled={!!busy}>Faces (download + time)</button>
    <button onclick={benchDepth} disabled={!!busy}>Depth (download + time)</button>
    <button onclick={benchBeats} disabled={!!busy}>Beat tracking</button>
    <button onclick={benchRender} disabled={!!busy}>Renderer</button>
    <button onclick={benchExport} disabled={!!busy}>Export spike (10 s)</button>
    {#if busy}<span class="dim">running {busy}…</span>{/if}
  </div>
  <canvas bind:this={canvas} width="640" height="360"></canvas>
  <div class="card">
    <h3>Results</h3>
    <table><thead><tr><th>Test</th><th>Result</th><th>Time</th></tr></thead><tbody>
      {#each rows as r}<tr><td>{r.test}</td><td>{r.result}</td><td>{r.ms !== undefined ? r.ms.toFixed(0) + " ms" : ""}</td></tr>{/each}
    </tbody></table>
    {#if rows.length}<textarea readonly rows="6" value={table}></textarea>{/if}
    <p class="dim small">Models listed in Settings: {MODELS.map((m) => m.name).join(", ")}.</p>
  </div>
</div>

<style>
  .page { max-width: 980px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  header a { color: var(--text); text-decoration: none; font-weight: 600; }
  canvas { width: 480px; max-width: 100%; border-radius: 8px; background: #000; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); padding: 4px 6px; } td { padding: 6px; border-top: 1px solid var(--line); vertical-align: top; }
  textarea { width: 100%; font-family: monospace; font-size: 12px; margin-top: 8px; }
</style>
