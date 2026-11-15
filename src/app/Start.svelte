<script lang="ts">
  import { onMount } from "svelte";
  import Dropzone from "./Dropzone.svelte";
  import { app, newProject } from "$lib/store/project.svelte";
  import { projectsDb } from "$lib/store/db";
  import { importer } from "$lib/media/importer.svelte";
  import { detect, type Capabilities } from "$lib/media/tier";
  import type { Project } from "$lib/planner/types";
  import { requestPersist } from "$lib/store/opfs";
  import { importPackage, PACKAGE_EXT } from "$lib/store/package";

  let recent = $state<Project[]>([]);
  let caps = $state<Capabilities | null>(null);
  onMount(async () => { recent = await projectsDb.list(); caps = await detect(); });

  async function start(files: { file: File; handle?: FileSystemFileHandle }[]) {
    const pkg = files.find((f) => f.file.name.toLowerCase().endsWith(PACKAGE_EXT));
    if (pkg) { await openFile(pkg.file); return; }
    const p = newProject();
    await projectsDb.put(p);
    await app.load(p);
    void requestPersist();
    const r = await importer.run(files);
    await app.addMedia(r.media, r.songs);
    if (!r.media.length) { app.say("No photos or videos were found in what you dropped."); return; }
    location.hash = `#/make/${p.id}`;
  }
  let opening = $state<{ share: number; step: string } | null>(null);
  async function openPackage(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) await openFile(f);
  }
  async function openFile(f: File) {
    opening = { share: 0, step: "Reading the file" };
    try {
      void requestPersist();
      const r = await importPackage(f, (share, step) => (opening = { share, step }));
      app.say(`Opened "${f.name}": ${r.media} item${r.media === 1 ? "" : "s"}, ${r.songs} song${r.songs === 1 ? "" : "s"}${r.analysis ? "" : "; photos will be analysed again"}.`);
      location.hash = `#/edit/${r.projectId}`;
    } catch (err) {
      app.say(err instanceof Error ? err.message : String(err), 8000);
    } finally {
      opening = null;
    }
  }
  async function remove(id: string) { await projectsDb.remove(id); recent = recent.filter((p) => p.id !== id); }
  const tierText = (c: Capabilities) => c.tier === "full" ? "Full tier: all features, fastest analysis." : c.tier === "standard" ? "Standard tier: all features, slower analysis without WebGPU." : "Lite tier: faces, beats and playback. For big shows use a desktop browser.";
</script>

<div class="page">
  <header class="row">
    <div class="brand"><span class="logo">◐</span> Lantern</div>
    <div class="row"><a href="#/settings">Settings</a><a href="#/bench">Bench</a></div>
  </header>
  <section class="hero">
    <h1>Slideshows that build themselves.</h1>
    <p class="dim">Drop your photos, videos and a song. Lantern looks at every picture, listens to the music, and plans the whole show. Then you change anything you like and export a video.</p>
    <p class="trust">Your photos never leave this device. There is no upload, no account and no server.</p>
  </section>
  <section>
    {#if importer.running && importer.progress}
      <div class="card">
        <div>Importing {importer.progress.done} of {importer.progress.total}… <span class="dim">{importer.progress.current}</span></div>
        <progress value={importer.progress.done} max={importer.progress.total}></progress>
      </div>
    {:else if opening}
      <div class="card">
        <div>Opening project file… <span class="dim">{opening.step}</span></div>
        <progress value={opening.share} max="1"></progress>
      </div>
    {:else}
      <Dropzone onfiles={start} />
      <label class="open dim small">Have a project file? <span class="link">Open a {PACKAGE_EXT} file</span><input type="file" accept={PACKAGE_EXT} onchange={openPackage} /></label>
    {/if}
  </section>
  {#if recent.length}
    <section>
      <h3>Recent shows</h3>
      <div class="grid">
        {#each recent as p (p.id)}
          <div class="card proj">
            <a href={p.slides.length ? `#/edit/${p.id}` : `#/make/${p.id}`} class="title">{p.title}</a>
            <div class="dim small">{p.media.length} items · {p.songs.length} song{p.songs.length === 1 ? "" : "s"} · {new Date(p.updated).toLocaleDateString()}</div>
            <button class="ghost small danger" onclick={() => remove(p.id)}>Delete</button>
          </div>
        {/each}
      </div>
    </section>
  {/if}
  {#if caps}
    <footer class="dim small">
      {tierText(caps)}
      {#if !caps.webcodecs} Video export needs WebCodecs (Chrome or Edge); this browser can only record in real time.{/if}
      {#if !caps.webgl2} WebGL2 is missing, so the preview cannot run here.{/if}
    </footer>
  {/if}
</div>

<style>
  .page { max-width: 880px; margin: 0 auto; padding: 24px 20px 40px; display: flex; flex-direction: column; gap: 24px; }
  header { justify-content: space-between; }
  header .row { gap: 16px; }
  .brand { font-size: 20px; font-weight: 600; display: flex; gap: 8px; align-items: center; }
  .logo { color: var(--accent); }
  .hero h1 { font-size: 34px; }
  .trust { color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .proj { display: flex; flex-direction: column; gap: 6px; }
  .proj .title { color: var(--text); text-decoration: none; font-weight: 600; }
  progress { width: 100%; accent-color: var(--accent); }
  .open { display: block; margin-top: 10px; cursor: pointer; }
  .open .link { color: var(--accent); text-decoration: underline; }
  .open input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .open:focus-within .link { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
