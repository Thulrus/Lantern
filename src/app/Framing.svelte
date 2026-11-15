<script lang="ts">
  // Framing editor (spec §11.2): the photo inside the whole-photo frame, with one box per framing
  // of the move (start, any stops, end). Hit-testing is done here rather than by the boxes'
  // elements, so a box underneath another one, or one the same size, can still be grabbed: corners
  // win over bodies, the selected box wins over the others, and the chips select any box.
  import Thumb from "./Thumb.svelte";
  import { app } from "$lib/store/project.svelte";
  import { ASPECTS, DEPTH_TREATMENTS, type CamKey, type Slide } from "$lib/planner/types";
  import type { V3 } from "$lib/planner/camera";
  import { pairTreatment } from "$lib/planner/compile";
  import { fitFrame, frameGroups, resizeFrom, stageSize, straighten } from "$lib/planner/framing";
  let { slide }: { slide: Slide } = $props();

  const outAspect = $derived(app.project ? ASPECTS[app.project.output.aspect] : 16 / 9);
  const pair = $derived(slide.kind === "pair" && slide.items.length === 2);
  let cell = $state(0);
  const hash = $derived(slide.items[pair ? cell : 0]);
  const media = $derived(app.analysis.get(hash));
  const ia = $derived(media ? media.info.w / media.info.h : 1);
  const aspect = $derived(pair ? outAspect / 2 : outAspect);
  // The keys being edited: the slide's own, or one photo of a pair (its stored keys, else the automatic push).
  const cellKeys = (i: number): CamKey[] => slide.treatment.cells?.[i] ?? pairTreatment(slide, i, app.analysis.get(slide.items[i]), outAspect / 2).keys;
  const keys = $derived(pair ? cellKeys(cell) : slide.treatment.keys);
  const groups = $derived(frameGroups(keys));
  const depth = $derived(!pair && DEPTH_TREATMENTS.has(slide.treatment.id));
  const [sw, sh] = $derived(stageSize(ia, aspect));

  let active = $state(0);
  $effect(() => { if (active >= groups.length) active = groups.length - 1; });
  // Views while dragging; committed as one edit (one undo step) on release.
  let draft = $state<V3[] | null>(null);
  const views = $derived(draft ?? groups.map((g) => keys[g.keys[0]].view));

  let stage: HTMLDivElement, padEl: HTMLDivElement;
  let drag: { g: number; mode: "move" | [number, number]; p0: [number, number]; v0: V3 } | null = null;
  let hover = $state("default");

  // Camera coordinates (image heights, centred) <-> stage percentages.
  const px = (u: number) => (u / sw + 0.5) * 100, py = (v: number) => (v / sh + 0.5) * 100;
  const box = (v: V3) => ({ l: px(v[0] - (v[2] * aspect) / 2), t: py(v[1] - v[2] / 2), w: ((v[2] * aspect) / sw) * 100, h: (v[2] / sh) * 100 });
  function toCam(e: PointerEvent): [number, number] {
    const r = stage.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width - 0.5) * sw, ((e.clientY - r.top) / r.height - 0.5) * sh];
  }

  /** What is under the pointer: a box's corner first (selected box first), then a box's body
   *  (the selected box, then the smallest), so overlapping boxes stay reachable. */
  function hit(e: PointerEvent): { g: number; mode: "move" | [number, number] } | null {
    const r = stage.getBoundingClientRect();
    const ppu = r.width / sw; // pixels per image height
    const rad = e.pointerType === "touch" ? 22 : 12;
    const [u, v] = toCam(e);
    const order = [active, ...views.map((_, i) => i).filter((i) => i !== active)];
    for (const g of order) {
      const [vx, vy, vs] = views[g], hx = (vs * aspect) / 2, hy = vs / 2;
      for (const sx of [-1, 1]) for (const sy of [-1, 1])
        if (Math.hypot((u - (vx + sx * hx)) * ppu, (v - (vy + sy * hy)) * ppu) <= rad) return { g, mode: [sx, sy] };
    }
    const inside = (g: number) => { const [vx, vy, vs] = views[g]; return Math.abs(u - vx) <= (vs * aspect) / 2 && Math.abs(v - vy) <= vs / 2; };
    if (inside(active)) return { g: active, mode: "move" };
    const rest = order.slice(1).filter(inside).sort((a, b) => views[a][2] - views[b][2]);
    return rest.length ? { g: rest[0], mode: "move" } : null;
  }
  const cursorFor = (h: ReturnType<typeof hit>) => (!h ? "default" : h.mode === "move" ? "move" : h.mode[0] === h.mode[1] ? "nwse-resize" : "nesw-resize");

  function down(e: PointerEvent) {
    const h = hit(e);
    if (!h) return;
    e.preventDefault();
    padEl.setPointerCapture(e.pointerId);
    active = h.g;
    draft = views.map((v) => [...v] as V3);
    drag = { g: h.g, mode: h.mode, p0: toCam(e), v0: [...views[h.g]] as V3 };
  }
  function move(e: PointerEvent) {
    if (!drag || !draft) { hover = cursorFor(hit(e)); return; }
    const p = toCam(e), v = drag.v0;
    const next = drag.mode === "move" ? fitFrame([v[0] + p[0] - drag.p0[0], v[1] + p[1] - drag.p0[1], v[2]], ia, aspect) : resizeFrom(v, drag.mode, p, ia, aspect);
    draft[drag.g] = next;
  }
  function up() {
    if (!drag || !draft) return;
    const saved = groups.map((g) => keys[g.keys[0]].view);
    const changed = draft.some((v, i) => v.some((x, j) => Math.abs(x - saved[i][j]) > 1e-6));
    const g = drag.g, d = draft;
    drag = null;
    if (changed) commit(d);
    draft = null;
    seek(g);
  }

  function commit(vs: V3[], ks: CamKey[] = keys) {
    const gs = frameGroups(ks);
    const out = ks.map((k) => ({ ...k, view: [...k.view] as V3 }));
    gs.forEach((g, i) => { if (vs[i]) for (const k of g.keys) out[k].view = [...vs[i]] as V3; });
    if (pair) {
      const cells: [CamKey[], CamKey[]] = [cellKeys(0), cellKeys(1)];
      cells[cell] = out;
      app.setFraming(slide.id, { cells });
    } else app.setFraming(slide.id, { keys: out });
  }

  /** Show a frame in the preview: the moment of that key, kept inside the part of the slide where it is alone on screen. */
  function seek(g: number) {
    const tl = app.timeline, grp = groups[g];
    if (!tl || !grp) return;
    const i = tl.layers.findIndex((l) => l.id === slide.id);
    const l = tl.layers[i];
    if (!l) return;
    const nx = tl.layers[i + 1];
    const lo = slide.start, hi = (nx?.enter && nx.enter.type !== "cut" ? nx.enter.t0 : slide.start + slide.dur) - 0.04;
    app.playhead = Math.min(Math.max(l.t0 + grp.t * (l.t1 - l.t0), lo), Math.max(lo, hi));
  }
  function pick(g: number) { active = g; seek(g); }

  function key(e: KeyboardEvent) {
    const v = views[active];
    if (!v) return;
    const step = (e.shiftKey ? 0.05 : 0.01) * v[2];
    let n: V3 | null = null;
    if (e.key === "ArrowLeft") n = [v[0] - step, v[1], v[2]];
    else if (e.key === "ArrowRight") n = [v[0] + step, v[1], v[2]];
    else if (e.key === "ArrowUp") n = [v[0], v[1] - step, v[2]];
    else if (e.key === "ArrowDown") n = [v[0], v[1] + step, v[2]];
    else if (e.key === "+" || e.key === "=") n = [v[0], v[1], v[2] * (e.shiftKey ? 0.9 : 0.97)];
    else if (e.key === "-" || e.key === "_") n = [v[0], v[1], v[2] / (e.shiftKey ? 0.9 : 0.97)];
    if (!n) return;
    e.preventDefault();
    const vs = views.map((x) => [...x] as V3);
    vs[active] = fitFrame(n, ia, aspect);
    commit(vs);
  }

  function swap() {
    if (groups.length < 2) return;
    const vs = views.map((x) => [...x] as V3);
    const last = vs.length - 1;
    [vs[0], vs[last]] = [vs[last], vs[0]];
    commit(vs);
  }
  function removeStops() {
    const ks = straighten(keys);
    commit(frameGroups(ks).map((g) => ks[g.keys[0]].view), ks);
    active = 0;
  }
  const path = $derived(views.map((v) => `${px(v[0])},${py(v[1])}`).join(" "));
</script>

<div class="framing">
  {#if pair}
    <div class="chips" role="group" aria-label="Photo">
      {#each [0, 1] as i}<button class="small" class:on={cell === i} onclick={() => { cell = i; active = 0; }}>{i === 0 ? "Left photo" : "Right photo"}</button>{/each}
    </div>
  {/if}
  <div class="chips" role="group" aria-label="Frame">
    {#each groups as g, i}<button class="small chip" class:on={active === i} class:end={i === groups.length - 1 && i > 0} onclick={() => pick(i)}>{g.label}</button>{/each}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a custom widget: pointer and arrow-key editing) -->
  <div class="pad" bind:this={padEl} style="cursor: {hover}" role="application" tabindex="0"
    aria-label="Framing editor: drag a box to move it, drag a corner to resize; arrow keys move the selected box, + and - zoom"
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onpointerleave={() => { if (!drag) hover = "default"; }} onkeydown={key}>
    <div class="stage" bind:this={stage} style="aspect-ratio: {sw} / {sh}">
      <div class="photo" style="left: {px(-ia / 2)}%; top: {py(-0.5)}%; width: {(ia / sw) * 100}%; height: {(1 / sh) * 100}%"><Thumb {hash} /></div>
      {#if views.length > 1}
        <svg class="path" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={path} vector-effect="non-scaling-stroke" /></svg>
      {/if}
      {#each views as v, i}
        {@const b = box(v)}
        <div class="box" class:on={i === active} class:end={i === views.length - 1 && i > 0} class:stop={i > 0 && i < views.length - 1}
          style="left: {b.l}%; top: {b.t}%; width: {b.w}%; height: {b.h}%; z-index: {i === active ? 3 : 1}">
          <span>{groups[i]?.label}</span>
          {#if i === active}<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>{/if}
        </div>
      {/each}
    </div>
  </div>
  <div class="row">
    {#if groups.length > 1}<button class="small" onclick={swap} title="Start where it ends and end where it starts">Swap start and end</button>{/if}
    {#if groups.length > 2}<button class="small" onclick={removeStops} title="Go straight from the start framing to the end framing">Remove stops</button>{/if}
    <button class="small" onclick={() => app.resetFraming(slide)}>Reset</button>
  </div>
  <p class="dim small">
    Drag a box to move it, a corner to resize; pick a box above when they overlap. Selecting a box shows that moment in the preview.
    {#if depth}This 3D move also moves the camera; boxes show the framing at the subject.{/if}
    Changes lock this slide's motion.
  </p>
</div>

<style>
  .framing { display: flex; flex-direction: column; gap: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips button.on { background: var(--accent); color: #1a1205; border-color: transparent; }
  .chips button.chip.end.on { background: var(--accent2); color: #fff; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  /* Padding so corner handles on the stage's edge stay visible and grabbable. */
  .pad { flex: none; padding: 12px; background: #000; border-radius: 8px; user-select: none; touch-action: none; outline: none; }
  .pad:focus-visible { box-shadow: 0 0 0 2px var(--accent2); }
  .stage { position: relative; width: 100%; background: #111; }
  .photo { position: absolute; pointer-events: none; outline: 1px solid #fff3; }
  .path { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 2; }
  .path polyline { fill: none; stroke: #fffa; stroke-width: 1.5; stroke-dasharray: 4 3; }
  .box { position: absolute; border: 1.5px solid var(--accent); box-sizing: border-box; pointer-events: none; opacity: 0.6; }
  .box.end { border-color: var(--accent2); border-style: dashed; }
  .box.stop { border-color: #ddd; border-style: dotted; }
  .box.on { opacity: 1; border-width: 2px; }
  .box span { position: absolute; left: 2px; top: 0; font-size: 10px; background: #000a; padding: 0 4px; white-space: nowrap; }
  .box.end span { left: auto; right: 2px; top: auto; bottom: 0; }
  .c { position: absolute; width: 12px; height: 12px; background: #fff; border: 1px solid #000; border-radius: 2px; box-sizing: border-box; }
  .tl { left: -6px; top: -6px; } .tr { right: -6px; top: -6px; } .bl { left: -6px; bottom: -6px; } .br { right: -6px; bottom: -6px; }
</style>
