<script lang="ts">
  import { onMount } from "svelte";
  import Dropzone from "./Dropzone.svelte";
  import Seg from "../ui/Seg.svelte";
  import { app } from "$lib/store/project.svelte";
  import { importer } from "$lib/media/importer.svelte";
  import { STYLES } from "$lib/planner/styles";
  import type { Aspect } from "$lib/planner/types";
  import { fmtClock } from "$lib/util/math";
  let { id }: { id: string } = $props();
  let ready = $state(false);
  onMount(async () => { if (app.project?.id !== id) { if (!(await app.open(id))) { location.hash = "#/"; return; } } ready = true; });

  const aspects: { v: Aspect; label: string; help: string }[] = [
    { v: "16:9", label: "16:9", help: "Widescreen, for TVs and laptops." }, { v: "9:16", label: "9:16", help: "Vertical, for phones and stories." },
    { v: "1:1", label: "1:1", help: "Square." }, { v: "4:5", label: "4:5", help: "Portrait, for feeds." }, { v: "21:9", label: "21:9", help: "Ultra-wide, cinematic." },
  ];
  async function addSongs(files: { file: File; handle?: FileSystemFileHandle }[]) {
    const r = await importer.run(files);
    await app.addMedia(r.media, r.songs);
  }
  function removeSong(hash: string) { app.edit((p) => { p.songs = p.songs.filter((s) => s.hash !== hash); }, undefined, { replan: true }); app.userEdited = false; }
  function make() {
    app.replan({ silent: true });
    app.userEdited = false;
    location.hash = `#/edit/${id}`;
  }
  const prog = $derived(app.progress());
</script>

{#if ready && app.project}
  <div class="page">
    <header class="row"><a href="#/">◐ Lantern</a><span class="dim">›</span><input class="title" bind:value={app.project.title} onchange={() => app.save()} /></header>
    <div class="cols">
      <section class="col">
        <h3>Style</h3>
        <div class="styles">
          {#each STYLES as s (s.id)}
            <button class="style" class:on={app.project.styleId === s.id} onclick={() => { app.project!.styleId = s.id; app.save(); }}>
              <strong>{s.name}</strong><span class="dim small">{s.blurb}</span>
            </button>
          {/each}
        </div>
      </section>
      <section class="col">
        <h3>Music</h3>
        {#each app.project.songs as s (s.hash)}
          {@const info = app.songs.get(s.hash)}
          <div class="card row song">
            <span>{info?.info.name ?? s.hash}</span>
            <span class="dim small">{info ? fmtClock(info.info.duration) : ""}{#if app.music.get(s.hash)} · {Math.round(app.music.get(s.hash)!.tempo)} BPM{:else} · analysing…{/if}</span>
            <button class="ghost small" onclick={() => removeSong(s.hash)}>Remove</button>
          </div>
        {/each}
        <Dropzone compact onfiles={addSongs}>
          <span class="dim">{app.project.songs.length ? "Add another song" : "Drop a song, or make the show without music"}</span>
        </Dropzone>
        {#if importer.running && importer.progress}<progress value={importer.progress.done} max={importer.progress.total}></progress>{/if}
        <h3>Format</h3>
        <Seg label="" options={aspects} value={app.project.output.aspect} onchange={(v) => { app.project!.output.aspect = v; app.save(); }} />
      </section>
    </div>
    <footer class="row">
      <span class="dim">{app.project.media.length} items · faces found for {prog.faces} of {prog.total}</span>
      <button class="primary big" onclick={make} disabled={!app.project.media.length}>Make my show</button>
    </footer>
  </div>
{/if}

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; min-height: 100%; }
  header a { color: var(--text); text-decoration: none; font-weight: 600; }
  .title { font-size: 18px; background: transparent; border-color: transparent; flex: 1; }
  .title:focus { border-color: var(--line); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
  .styles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .style { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; padding: 12px; border-radius: 12px; }
  .style.on { border-color: var(--accent); background: #f3b64b14; }
  .song { justify-content: space-between; }
  footer { justify-content: space-between; margin-top: auto; }
  .big { font-size: 16px; padding: 12px 22px; }
  progress { width: 100%; accent-color: var(--accent); }
</style>
