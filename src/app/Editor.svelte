<script lang="ts">
  import { onMount } from "svelte";
  import Preview from "./Preview.svelte";
  import Storyboard from "./Storyboard.svelte";
  import TimelineView from "./TimelineView.svelte";
  import Inspector from "./Inspector.svelte";
  import Library from "./Library.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import Hint from "../ui/Hint.svelte";
  import { app } from "$lib/store/project.svelte";
  let { id }: { id: string } = $props();
  let ready = $state(false);
  let bottom = $state<"storyboard" | "timeline">("storyboard");
  let library = $state(false);
  let exporting = $state(false);
  let preview = $state<Preview | null>(null);
  onMount(async () => {
    if (app.project?.id !== id) { if (!(await app.open(id))) { location.hash = "#/"; return; } }
    ready = true;
  });
  const prog = $derived(app.progress());

  function key(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
    const p = preview?.getPlayer();
    if (e.key === " ") { e.preventDefault(); p?.toggle(); }
    else if (e.key === "k") p?.pause();
    else if (e.key === "j") p?.seek((p?.time ?? 0) - 5);
    else if (e.key === "l") p?.seek((p?.time ?? 0) + 5);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Delete" || e.key === "Backspace") { if (app.selected.length) app.edit((pr) => { for (const s of pr.slides) if (app.selected.includes(s.id)) pr.excluded.push(...s.items); pr.slides = pr.slides.filter((s) => !app.selected.includes(s.id)); app.selected = []; }); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); app.undoEdit(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "Z" || (e.key === "z" && e.shiftKey) || e.key === "y")) { e.preventDefault(); app.redoEdit(); }
    else if (e.key === "L") lockSel();
  }
  function step(d: number) {
    const slides = app.project?.slides ?? [];
    if (!slides.length) return;
    const i = Math.max(0, slides.findIndex((s) => s.id === app.selected[0]));
    const n = Math.max(0, Math.min(slides.length - 1, i + d));
    app.selected = [slides[n].id]; app.playhead = slides[n].start + 0.1;
  }
  function lockSel() {
    app.edit((p) => { for (const s of p.slides) if (app.selected.includes(s.id)) { const all = Object.keys(s.locks).length >= 4; s.locks = all ? {} : { dur: true, treatment: true, transition: true, position: true }; } });
  }
  function applyUpgrade() { app.replan({}); app.pendingUpgrade = 0; }
</script>

<svelte:window onkeydown={key} />

{#if ready && app.project}
  <div class="editor">
    <header class="row">
      <a href="#/" class="brand">◐</a>
      <input class="title" bind:value={app.project.title} onchange={() => app.save()} />
      <span class="dim small status">{prog.faces < prog.total ? `faces found for ${prog.faces} of ${prog.total}` : `${prog.total} items analysed`}{app.dirty ? " · saving…" : ""}</span>
      {#if app.pendingUpgrade}<button class="small" onclick={applyUpgrade}>New analysis for {app.pendingUpgrade} items: apply</button>{/if}
      <div class="row">
        <button class="ghost" onclick={() => app.undoEdit()} disabled={!app.canUndo} title="Undo (Ctrl+Z)">↶</button>
        <button class="ghost" onclick={() => app.redoEdit()} disabled={!app.canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button onclick={() => (library = !library)}>Library</button>
        <button onclick={() => app.replan({ newSeed: true })} title="Re-plan every unlocked choice with a new seed">Re-roll</button>
        <button class="primary" onclick={() => (exporting = true)}>Export</button>
      </div>
    </header>
    <main class:lib={library}>
      {#if library}<aside class="library card"><Library /></aside>{/if}
      <section class="preview"><Preview bind:this={preview} /></section>
      <aside class="inspector card"><Inspector /></aside>
      <section class="bottom card">
        <div class="row tabs">
          <button class:on={bottom === "storyboard"} class="ghost" onclick={() => (bottom = "storyboard")}>Storyboard</button>
          <button class:on={bottom === "timeline"} class="ghost" onclick={() => (bottom = "timeline")}>Timeline</button>
          <span class="dim small">{app.project.slides.length} slides · {app.planResult?.mismatch ? `needs ${Math.round(app.planResult.mismatch.need)} s, music ${Math.round(app.planResult.mismatch.have)} s` : ""}</span>
        </div>
        <div class="fill">
          {#if bottom === "storyboard"}<Storyboard />{:else}<TimelineView />{/if}
        </div>
      </section>
    </main>
    <Hint lines={["Space plays · ← → select slides", "Drag a slide to reorder · L locks it", "Ctrl+Z undoes anything"]} />
  </div>
  {#if exporting}<ExportDialog onclose={() => (exporting = false)} />{/if}
{/if}

<style>
  .editor { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; position: relative; }
  header { gap: 10px; }
  .brand { color: var(--accent); text-decoration: none; font-size: 20px; }
  .title { background: transparent; border-color: transparent; font-size: 16px; font-weight: 600; min-width: 120px; flex: 1; }
  .title:focus { border-color: var(--line); }
  .status { white-space: nowrap; }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 320px; grid-template-rows: 1fr 190px; gap: 8px; grid-template-areas: "preview inspector" "bottom bottom"; }
  main.lib { grid-template-columns: 300px 1fr 320px; grid-template-areas: "library preview inspector" "bottom bottom bottom"; }
  .library { grid-area: library; padding: 0; min-height: 0; }
  .preview { grid-area: preview; min-height: 0; }
  .inspector { grid-area: inspector; padding: 0; min-height: 0; }
  .bottom { grid-area: bottom; padding: 6px; display: flex; flex-direction: column; min-height: 0; }
  .tabs button.on { background: #2a2a44; }
  .fill { flex: 1; min-height: 0; }
  @media (max-width: 860px) {
    main, main.lib { grid-template-columns: 1fr; grid-template-rows: auto 170px auto; grid-template-areas: "preview" "bottom" "inspector"; overflow-y: auto; }
    .library { display: none; }
    .inspector { max-height: 50vh; }
  }
</style>
