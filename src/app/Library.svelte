<script lang="ts">
  // Library drawer: everything imported, with quality filters; suggested-out items dimmed with the reason.
  import Dropzone from "./Dropzone.svelte";
  import Thumb from "./Thumb.svelte";
  import { app } from "$lib/store/project.svelte";
  import { importer } from "$lib/media/importer.svelte";
  let filter = $state<"all" | "out" | "faces" | "flagged">("all");
  const items = $derived.by(() => {
    const p = app.project;
    if (!p) return [];
    const out = app.planResult?.suggestedOut ?? {};
    return p.media.map((h) => {
      const a = app.analysis.get(h);
      const inShow = p.slides.some((s) => s.items.includes(h));
      return { h, a, reason: out[h], excluded: p.excluded.includes(h), inShow, faces: a?.faces?.filter((f) => f.score >= 0.5).length ?? 0, flags: a?.basics?.flags ?? [] };
    }).filter((x) => filter === "all" || (filter === "out" && (x.reason || x.excluded)) || (filter === "faces" && x.faces > 0) || (filter === "flagged" && x.flags.length));
  });
  async function add(files: { file: File; handle?: FileSystemFileHandle }[]) {
    const r = await importer.run(files);
    await app.addMedia(r.media, r.songs);
    app.say(`Added ${r.media.length} items${r.songs.length ? ` and ${r.songs.length} songs` : ""}.`);
  }
  function toggle(h: string) {
    app.edit((p) => {
      if (p.excluded.includes(h)) p.excluded = p.excluded.filter((x) => x !== h);
      else if (app.planResult?.suggestedOut[h]) { if (!p.starred.includes(h)) p.starred.push(h); }
      else p.excluded.push(h);
    }, undefined, { replan: true });
  }
</script>

<div class="lib">
  <div class="row head">
    <strong>Library</strong>
    <select bind:value={filter}><option value="all">All</option><option value="faces">With faces</option><option value="flagged">Flagged</option><option value="out">Left out</option></select>
    <span class="dim small">{items.length}</span>
  </div>
  <div class="grid">
    {#each items as it (it.h)}
      <button class="item" class:dim={!!it.reason || it.excluded} class:in={it.inShow} onclick={() => toggle(it.h)} title={it.reason ?? (it.excluded ? "Excluded: click to include" : it.inShow ? "In the show: click to exclude" : "Not in the show")}>
        <Thumb hash={it.h} />
        {#if it.faces}<span class="f">{it.faces}</span>{/if}
        {#if it.reason}<span class="r">{it.reason}</span>{:else if it.excluded}<span class="r">Excluded</span>{/if}
      </button>
    {/each}
  </div>
  <Dropzone compact onfiles={add}><span class="dim small">Add more</span></Dropzone>
  {#if importer.running && importer.progress}<progress value={importer.progress.done} max={importer.progress.total}></progress>{/if}
</div>

<style>
  .lib { display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 8px; }
  .head { justify-content: space-between; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; overflow-y: auto; flex: 1; align-content: start; }
  .item { position: relative; aspect-ratio: 1; padding: 0; border-radius: 6px; overflow: hidden; border: 2px solid transparent; background: #000; }
  .item.in { border-color: #ffffff30; }
  .item.dim :global(img) { opacity: .35; }
  .f { position: absolute; left: 4px; top: 4px; font-size: 10px; background: #000a; padding: 0 5px; border-radius: 4px; }
  .r { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px; background: #000c; padding: 2px 4px; color: var(--accent); }
  progress { width: 100%; accent-color: var(--accent); }
</style>
