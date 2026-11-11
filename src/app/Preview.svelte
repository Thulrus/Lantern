<script lang="ts">
  // The preview player: a canvas at the show's aspect, transport controls, scrub bar.
  import { onDestroy, onMount } from "svelte";
  import { Player } from "$lib/render/player";
  import { app } from "$lib/store/project.svelte";
  import { decodeAudio } from "$lib/media/import";
  import { originalsDb } from "$lib/store/db";
  import { fmtClock } from "$lib/util/math";
  import { detect } from "$lib/media/tier";

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let player = $state<Player | null>(null);
  let error = $state<string | null>(null);
  let fps = $state(0);
  const aspect = $derived(app.timeline?.aspect ?? 16 / 9);
  const dur = $derived(app.timeline?.dur ?? 0);
  let loadedAudio = new Set<string>();

  export function getPlayer(): Player | null { return player; }

  onMount(() => {
    let cleanup: (() => void) | null = null;
    void (async () => {
    const caps = await detect();
    try {
      const p = new Player(canvas, caps.tier === "lite");
      p.onTime = (t) => { app.playhead = t; app.playing = p.playing; };
      p.onEnd = () => { app.playing = false; };
      player = p;
      const ro = new ResizeObserver(() => p.resize());
      ro.observe(wrap);
      p.resize();
      const fpsTimer = setInterval(() => { const ft = p.frameTimes; fps = ft.length ? Math.round(1000 / Math.max(1, ft.reduce((a, b) => a + b, 0) / ft.length)) : 0; }, 1000);
      cleanup = () => { ro.disconnect(); clearInterval(fpsTimer); };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    })();
    return () => cleanup?.();
  });
  onDestroy(() => player?.dispose());

  $effect(() => {
    const tl = app.timeline, p = player;
    if (!tl || !p) return;
    p.setTimeline(tl);
    for (const src of new Set(tl.audio.map((e) => e.src))) {
      if (loadedAudio.has(src)) continue;
      loadedAudio.add(src);
      originalsDb.get(src).then(async (b) => { if (b) { p.buffers.set(src, await decodeAudio(b)); if (p.playing) p.seek(p.time); } });
    }
  });
  $effect(() => { const p = player; if (!p) return; if (Math.abs(p.time - app.playhead) > 0.02 && !p.playing) p.seek(app.playhead); });

  function scrub(e: PointerEvent) {
    const el = e.currentTarget as HTMLDivElement;
    const r = el.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * dur;
    app.playhead = t; player?.seek(t);
  }
  function fullscreen() { wrap.requestFullscreen?.(); }
  const draft = $derived(app.project ? app.project.slides.some((s) => s.auto.quality === "draft" && s.kind !== "title") : false);
</script>

<div class="preview">
  <div class="stage" bind:this={wrap} style="aspect-ratio: {aspect}">
    <canvas bind:this={canvas} ondblclick={fullscreen} onclick={() => player?.toggle()}></canvas>
    {#if error}<div class="err">{error}</div>{/if}
    {#if draft}<span class="badge" title="Depth and mattes arrive in the background; slides upgrade as they land.">draft</span>{/if}
  </div>
  <div class="bar">
    <button class="ghost" onclick={() => player?.toggle()} aria-label={app.playing ? "Pause" : "Play"}>{app.playing ? "❚❚" : "▶"}</button>
    <span class="time">{fmtClock(app.playhead)} / {fmtClock(dur)}</span>
    <div class="scrub" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax={dur} aria-valuenow={app.playhead} onpointerdown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrub(e); }} onpointermove={(e) => { if (e.buttons) scrub(e); }}>
      <div class="fill" style="width: {dur ? (app.playhead / dur) * 100 : 0}%"></div>
    </div>
    <span class="dim small">{fps ? `${fps} fps` : ""}</span>
    <button class="ghost" onclick={fullscreen} aria-label="Full screen">⛶</button>
  </div>
</div>

<style>
  .preview { display: flex; flex-direction: column; gap: 6px; min-height: 0; height: 100%; }
  .stage { position: relative; background: #000; border-radius: 10px; overflow: hidden; margin: 0 auto; max-height: calc(100% - 44px); max-width: 100%; height: auto; width: 100%; }
  .stage:fullscreen { border-radius: 0; max-height: 100%; }
  canvas { width: 100%; height: 100%; display: block; }
  .err { position: absolute; inset: 0; display: grid; place-items: center; color: var(--danger); padding: 20px; text-align: center; }
  .badge { position: absolute; top: 8px; right: 8px; background: #0009; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: .06em; }
  .bar { display: flex; align-items: center; gap: 10px; }
  .time { font-variant-numeric: tabular-nums; font-size: 13px; min-width: 90px; }
  .scrub { flex: 1; height: 18px; display: flex; align-items: center; cursor: pointer; }
  .scrub::before { content: ""; position: absolute; }
  .scrub { position: relative; }
  .scrub .fill { height: 4px; background: var(--accent); border-radius: 2px; position: relative; z-index: 1; }
  .scrub::after { content: ""; position: absolute; left: 0; right: 0; height: 4px; background: var(--line); border-radius: 2px; }
</style>
