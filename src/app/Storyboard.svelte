<script lang="ts">
  // Storyboard: slide cards in order with thumbnails, duration, treatment, locks and analysis dots. Drag to reorder.
  import Thumb from "./Thumb.svelte";
  import { app } from "$lib/store/project.svelte";
  import { TREATMENT_NAMES, type Slide } from "$lib/planner/types";
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  const slides = $derived(app.project?.slides ?? []);
  const icon: Record<string, string> = { hold: "▢", push: "⊕", pull: "⊖", pan: "↔", sweep: "⇶", tour: "⤳", depthPush: "◈", arc: "◠", crane: "⇅", inflate: "✺", dollyZoom: "◎", focusPull: "◉" };

  function select(e: MouseEvent, s: Slide) {
    if (e.shiftKey && app.selected.length) {
      const a = slides.findIndex((x) => x.id === app.selected[0]), b = slides.findIndex((x) => x.id === s.id);
      app.selected = slides.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
    } else if (e.metaKey || e.ctrlKey) app.selected = app.selected.includes(s.id) ? app.selected.filter((x) => x !== s.id) : [...app.selected, s.id];
    else app.selected = [s.id];
    app.playhead = s.start + Math.min(0.5, s.dur / 2);
  }
  function drop(target: Slide) {
    if (!dragId || dragId === target.id) { dragId = null; overId = null; return; }
    const moving = app.selected.includes(dragId) ? app.selected : [dragId];
    app.edit((p) => {
      const picked = p.slides.filter((s) => moving.includes(s.id));
      const rest = p.slides.filter((s) => !moving.includes(s.id));
      const at = rest.findIndex((s) => s.id === target.id);
      rest.splice(at < 0 ? rest.length : at, 0, ...picked);
      p.slides = rest;
      p.order = "manual";
      for (const s of picked) s.locks.position = true;
    });
    dragId = null; overId = null;
  }
  const dot = (hash: string, stage: string) => { const st = app.stageStatus.get(`${hash}|${stage}`); return st === "ok" || st === "skipped" ? "ok" : st === "error" ? "err" : st ? "run" : ""; };
</script>

<div class="board" role="list">
  {#each slides as s, i (s.id)}
    <div role="button" class="card" class:on={app.selected.includes(s.id)} class:over={overId === s.id} class:title={s.kind === "title"} class:current={app.playhead >= s.start && app.playhead < s.start + s.dur}
      draggable="true" ondragstart={() => (dragId = s.id)} ondragover={(e) => { e.preventDefault(); overId = s.id; }} ondragleave={() => (overId = null)} ondrop={() => drop(s)}
      onclick={(e) => select(e, s)} onkeydown={(e) => { if (e.key === "Enter") select(e as unknown as MouseEvent, s); }} tabindex="0">
      <div class="img">
        {#if s.kind === "title"}<div class="tcard">{s.caption?.text ?? "Title"}</div>
        {:else if s.kind === "pair"}<div class="pair"><Thumb hash={s.items[0]} /><Thumb hash={s.items[1]} /></div>
        {:else}<Thumb hash={s.items[0]} />{/if}
        <span class="n">{i + 1}</span>
        <span class="tr" title={TREATMENT_NAMES[s.treatment.id]}>{icon[s.treatment.id] ?? "·"}</span>
        {#if Object.keys(s.locks).length}<span class="lk" title={Object.keys(s.locks).join(", ") + " locked"}>🔒</span>{/if}
      </div>
      <div class="meta">
        <span>{s.dur.toFixed(1)} s</span>
        {#if s.kind !== "title"}<span class="dots"><i class={dot(s.items[0], "basics")} title="basics"></i><i class={dot(s.items[0], "faces")} title="faces"></i><i class={dot(s.items[0], "depth")} title="depth"></i></span>{/if}
      </div>
    </div>
  {/each}
  {#if !slides.length}<div class="dim">No slides yet.</div>{/if}
</div>

<style>
  .board { display: flex; gap: 8px; overflow-x: auto; padding: 6px 4px; height: 100%; align-items: flex-start; }
  .card { flex: none; width: 128px; border-radius: 8px; border: 2px solid transparent; background: var(--panel2); cursor: grab; display: flex; flex-direction: column; overflow: hidden; }
  .card.on { border-color: var(--accent); }
  .card.over { border-color: var(--accent2); }
  .card.current .img::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 2px #fff6; }
  .img { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; height: 100%; }
  .tcard { display: grid; place-items: center; height: 100%; font-size: 11px; padding: 4px; text-align: center; color: #fff; background: #111; }
  .n, .tr, .lk { position: absolute; font-size: 10px; background: #000a; padding: 1px 5px; border-radius: 4px; }
  .n { left: 4px; top: 4px; } .tr { right: 4px; top: 4px; font-size: 12px; } .lk { right: 4px; bottom: 4px; }
  .meta { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; font-size: 11px; color: var(--dim); }
  .dots { display: flex; gap: 3px; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: #333; display: inline-block; }
  .dots i.ok { background: var(--ok); } .dots i.run { background: var(--accent); } .dots i.err { background: var(--danger); }
</style>
