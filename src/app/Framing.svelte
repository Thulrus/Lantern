<script lang="ts">
  // Framing editor (spec §11.2): the photo with the move's start and end rectangles to drag.
  import Thumb from "./Thumb.svelte";
  import { app } from "$lib/store/project.svelte";
  import { ASPECTS, type MediaAnalysis, type Slide } from "$lib/planner/types";
  import { clampViewFlat } from "$lib/planner/camera";
  let { slide, media }: { slide: Slide; media: MediaAnalysis } = $props();
  const ia = $derived(media.info.w / media.info.h);
  const aspect = $derived(app.project ? ASPECTS[app.project.output.aspect] : 16 / 9);
  // A view [vx, vy, vs] (image heights, centred) as a rect in image fractions.
  const rect = (v: [number, number, number]) => ({ x: (v[0] - (v[2] * aspect) / 2) / ia + 0.5, y: v[1] - v[2] / 2 + 0.5, w: (v[2] * aspect) / ia, h: v[2] });
  let el: HTMLDivElement;
  let drag: { k: number; x0: number; y0: number; v0: [number, number, number]; scale: boolean } | null = null;
  function down(e: PointerEvent, k: number, scale = false) {
    e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { k, x0: e.clientX, y0: e.clientY, v0: [...slide.treatment.keys[k].view] as [number, number, number], scale };
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - drag.x0) / r.width) * ia, dy = (e.clientY - drag.y0) / r.height;
    const v = drag.v0;
    const nv: [number, number, number] = drag.scale ? [v[0], v[1], Math.max(0.1, v[2] + dy)] : [v[0] + dx, v[1] + dy, v[2]];
    slide.treatment.keys[drag.k].view = clampViewFlat(nv[0], nv[1], nv[2], ia, aspect);
    app.project = app.project;
  }
  function up() {
    if (!drag) return;
    const k = drag.k, v = slide.treatment.keys[k].view;
    drag = null;
    app.edit((p) => { const s = p.slides.find((x) => x.id === slide.id); if (s) s.treatment.keys[k].view = v; }, { slideId: slide.id, fields: ["treatment"] });
  }
  const keys = $derived(slide.treatment.keys.length > 1 ? [0, slide.treatment.keys.length - 1] : [0]);
</script>

<div class="fr" role="application" aria-label="Framing editor" bind:this={el} style="aspect-ratio: {ia}" onpointermove={move} onpointerup={up} onpointercancel={up}>
  <Thumb hash={slide.items[0]} />
  {#each keys as k, i}
    {@const r = rect(slide.treatment.keys[k].view)}
    <div class="box" class:end={i === 1} style="left: {r.x * 100}%; top: {r.y * 100}%; width: {r.w * 100}%; height: {r.h * 100}%" role="button" tabindex="0" onpointerdown={(e) => down(e, k)}>
      <span>{i === 0 ? "start" : "end"}</span>
      <i class="h" role="button" tabindex="0" onpointerdown={(e) => down(e, k, true)}></i>
    </div>
  {/each}
</div>
<p class="dim small">Drag a rectangle to move it; drag its corner to resize. Changes lock this slide's motion.</p>

<style>
  .fr { position: relative; width: 100%; background: #000; border-radius: 8px; overflow: hidden; user-select: none; touch-action: none; }
  .box { position: absolute; border: 2px solid var(--accent); box-sizing: border-box; cursor: move; }
  .box.end { border-color: var(--accent2); border-style: dashed; }
  .box span { position: absolute; left: 2px; top: 0; font-size: 10px; background: #000a; padding: 0 4px; }
  .h { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; background: #fff; border-radius: 2px; cursor: nwse-resize; }
</style>
