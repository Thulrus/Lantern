<script lang="ts">
  import { onMount } from "svelte";
  import Dropzone from "./Dropzone.svelte";
  import Seg from "../ui/Seg.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import AnalysisStatus from "./AnalysisStatus.svelte";
  import { modelById } from "$lib/models/registry";
  import { modelStatus } from "$lib/models/fetch";
  import { FILL_MODEL } from "$lib/analysis/fill";
  import { fmtBytes } from "$lib/util/math";
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
  const pipe = $derived(app.pipeline());
  const style = $derived(app.style);
  const has3d = $derived((style?.depthShare ?? 0) > 0);
  let fillCached = $state(false);
  $effect(() => { void app.project?.generativeFill; void modelStatus(FILL_MODEL).then((s) => (fillCached = s.cached)); });
  const fillSize = fmtBytes(modelById(FILL_MODEL)?.bytes ?? 0);
</script>

{#if ready && app.project}
  <div class="page">
    <header class="row"><a href="#/">◐ Lantern</a><span class="dim">›</span><input class="title" bind:value={app.project.title} onchange={() => app.save()} /></header>
    <div class="cols">
      <section class="col">
        <h3>Style</h3>
        <div class="styles">
          {#each STYLES as s (s.id)}
            <button class="style" class:on={app.project.styleId === s.id} onclick={() => app.setStyle(s.id)}>
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
        <h3>3D and fill</h3>
        <div class="card col opts">
          <p class="small" class:dim={!has3d}>{has3d
            ? `${style?.name} moves photos in 3D. Each photo's depth is measured on this device first; until then it gets a 2D move.`
            : `${style?.name ?? "This style"} is 2D only. Pick Gentle, Cinematic, Upbeat or Travel for 3D moves.`}</p>
          <Toggle label="Generative fill behind people"
            help={`When the camera moves in 3D, it can uncover the background behind people. This paints that background with an on-device model, instead of a blurred halo. People themselves are never generated. ${fillCached ? "The model is downloaded." : `Downloads the model once (${fillSize}) when you turn it on.`} Slow: several seconds per photo.${has3d ? "" : ` ${style?.name ?? "This style"} is 2D, so the fill waits until you pick a 3D style.`}`}
            on={app.project.generativeFill === "all"} onchange={(v) => app.setGenerativeFill(v ? "all" : "off")} />
          <p class="dim small">Every option can be changed later in the editor (Show tab). New shows remember this choice.</p>
        </div>
      </section>
    </div>
    <AnalysisStatus mode="panel" />
    <footer class="row">
      <span class="dim small">{app.project.media.length} items.{pipe.busy ? " You don't have to wait: the show is made now and improves as the analysis finishes." : ""}</span>
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
  .opts p { margin: 0; }
</style>
