<script lang="ts">
  // Timeline: time-proportional slide blocks over the song waveform with beat ticks, bar numbers
  // and section bands coloured by energy. Drag a block's right edge to change its duration
  // (ripple; snaps to beats when beat sync is on; hold Alt to snap freely).
  import { app } from "$lib/store/project.svelte";
  import { musicGrid } from "$lib/planner/music";
  import { TREATMENT_NAMES } from "$lib/planner/types";
  let el: HTMLDivElement;
  let zoom = $state(40); // px per second
  const dur = $derived(Math.max(app.timeline?.dur ?? 0, 1));
  const grid = $derived(app.project ? musicGrid(app.project, app.music) : null);
  const width = $derived(Math.max(300, dur * zoom));
  const slides = $derived(app.project?.slides ?? []);
  const colour = (e: string) => (e === "high" ? "#e5604f33" : e === "low" ? "#5b8def33" : "#f3b64b22");

  let drag: { id: string; x0: number; dur0: number } | null = null;
  function startDrag(e: PointerEvent, id: string, d: number) {
    e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { id, x0: e.clientX, dur0: d };
  }
  function moveDrag(e: PointerEvent) {
    if (!drag) return;
    const s = app.project?.slides.find((x) => x.id === drag!.id);
    if (!s) return;
    let nd = Math.max(0.4, drag.dur0 + (e.clientX - drag.x0) / zoom);
    if (grid && app.style?.beatSync !== "off" && !e.altKey) {
      const end = s.start + nd;
      let best = end, bd = Infinity;
      for (const b of grid.beats) { const d = Math.abs(b - end); if (d < bd && b > s.start + 0.3) { bd = d; best = b; } }
      if (bd < 0.5) nd = best - s.start;
    }
    s.dur = nd;
    let t = 0; for (const x of app.project!.slides) { x.start = t; t += x.dur; }
    app.project = app.project; // trigger
  }
  function endDrag() {
    if (!drag) return;
    const id = drag.id; drag = null;
    const s = app.project?.slides.find((x) => x.id === id);
    if (!s) return;
    const d = s.dur;
    app.edit((p) => { const x = p.slides.find((y) => y.id === id); if (x) x.dur = d; }, { slideId: id, fields: ["dur"] });
  }
  function seek(e: MouseEvent) {
    const r = el.getBoundingClientRect();
    app.playhead = Math.max(0, Math.min(dur, (e.clientX - r.left + el.scrollLeft) / zoom));
  }
  function waveformPath(): string {
    if (!grid) return "";
    let d = "";
    for (const s of grid.songs) {
      const wf = s.analysis.waveform, per = 0.1;
      for (let i = 0; i < wf.length; i++) {
        const t = i * per;
        if (t < s.in || t > s.out) continue;
        const x = (s.at + t - s.in) * zoom, h = wf[i] * 22;
        d += `M${x.toFixed(1)} ${(24 - h).toFixed(1)} v${(2 * h).toFixed(1)} `;
      }
    }
    return d;
  }
</script>

<div class="tl" bind:this={el} role="presentation" onclick={seek} onwheel={(e) => { if (e.ctrlKey) { e.preventDefault(); zoom = Math.max(10, Math.min(300, zoom * (e.deltaY < 0 ? 1.15 : 0.87))); } }}>
  <div class="inner" style="width: {width}px">
    {#if grid}
      <div class="sections">
        {#each grid.songs as s}
          {#each s.analysis.sections as sec}
            {@const a = Math.max(sec.start, s.in)}
            {@const b = Math.min(sec.end, s.out)}
            {#if b > a}<div class="sec" style="left: {(s.at + a - s.in) * zoom}px; width: {(b - a) * zoom}px; background: {colour(sec.energy)}"><span>{sec.label}</span></div>{/if}
          {/each}
        {/each}
      </div>
      <svg class="wave" height="48" width={width}><path d={waveformPath()} stroke="#8a8aa0" stroke-width="1" /></svg>
      <div class="beats">
        {#each grid.beats as b, i}
          <i class:db={grid.downbeats.has(i)} style="left: {b * zoom}px"></i>
        {/each}
      </div>
    {/if}
    <div class="blocks" role="presentation" onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag}>
      {#each slides as s (s.id)}
        <div class="blk" class:on={app.selected.includes(s.id)} class:title={s.kind === "title"} style="left: {s.start * zoom}px; width: {Math.max(2, s.dur * zoom - 2)}px" title="{TREATMENT_NAMES[s.treatment.id]} · {s.dur.toFixed(1)} s"
          role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); app.selected = [s.id]; app.playhead = s.start + 0.1; }} onkeydown={() => {}}>
          <span class="lbl">{s.kind === "title" ? "T" : TREATMENT_NAMES[s.treatment.id]}</span>
          {#if s.transitionIn.dur > 0 && s.transitionIn.type !== "cut"}<i class="trn" style="width: {s.transitionIn.dur * zoom}px"></i>{/if}
          <div class="edge" role="separator" onpointerdown={(e) => startDrag(e, s.id, s.dur)}></div>
        </div>
      {/each}
    </div>
    <div class="head" style="left: {app.playhead * zoom}px"></div>
  </div>
</div>

<style>
  .tl { overflow-x: auto; overflow-y: hidden; height: 100%; position: relative; background: #0b0b0f; border-radius: 8px; user-select: none; }
  .inner { position: relative; height: 100%; min-height: 110px; }
  .sections { position: absolute; top: 0; height: 100%; left: 0; right: 0; }
  .sec { position: absolute; top: 0; height: 100%; border-left: 1px solid #ffffff22; }
  .sec span { position: absolute; top: 2px; left: 4px; font-size: 10px; color: var(--dim); }
  .wave { position: absolute; top: 14px; left: 0; opacity: .7; pointer-events: none; }
  .beats { position: absolute; top: 60px; height: 8px; left: 0; right: 0; }
  .beats i { position: absolute; top: 0; width: 1px; height: 4px; background: #666; }
  .beats i.db { height: 8px; background: #aaa; }
  .blocks { position: absolute; top: 70px; height: 34px; left: 0; right: 0; }
  .blk { position: absolute; top: 0; height: 100%; background: #2a2a44; border: 1px solid #3c3c5c; border-radius: 5px; overflow: hidden; font-size: 11px; display: flex; align-items: center; padding-left: 6px; cursor: pointer; }
  .blk.on { border-color: var(--accent); background: #3a3a2a; }
  .blk.title { background: #1f1f28; }
  .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .trn { position: absolute; left: 0; top: 0; height: 100%; background: linear-gradient(90deg, #ffffff33, transparent); pointer-events: none; }
  .edge { position: absolute; right: 0; top: 0; width: 8px; height: 100%; cursor: ew-resize; background: #ffffff10; }
  .head { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; }
</style>
