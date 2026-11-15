<script lang="ts">
  import { onMount } from "svelte";
  import { MODELS } from "$lib/models/registry";
  import { deleteModel, fetchModel, modelStatus, type ModelStatus } from "$lib/models/fetch";
  import { clearAll, storageEstimate } from "$lib/store/opfs";
  import { analysisDb, wipeEverything } from "$lib/store/db";
  import { detect, type Capabilities } from "$lib/media/tier";
  import { fmtBytes } from "$lib/util/math";
  import { app } from "$lib/store/project.svelte";
  const WHEN = { always: "Every show: fetched by itself during analysis", fill: "Only when a show has generative fill on", unused: "Not used yet (planned feature)" } as const;
  const groups = (["always", "fill", "unused"] as const).map((w) => ({ w, models: MODELS.filter((m) => m.when === w) }));
  let cleared = $state(false);
  let status = $state<Record<string, ModelStatus>>({});
  let store = $state<{ usage: number; quota: number; persisted: boolean } | null>(null);
  let caps = $state<Capabilities | null>(null);
  let busy = $state<string | null>(null);
  let confirmWipe = $state(false);
  async function refresh() {
    for (const m of MODELS) status[m.id] = await modelStatus(m.id);
    store = await storageEstimate();
  }
  onMount(async () => { await refresh(); caps = await detect(); });
  async function download(id: string) { busy = id; try { await fetchModel(id); } catch (e) { alert(String(e)); } busy = null; await refresh(); }
  async function del(id: string) { await deleteModel(id); await refresh(); }
</script>

<div class="page">
  <header class="row"><a href="#/">◐ Lantern</a><span class="dim">›</span><h2>Settings</h2></header>
  <p class="trust">Your photos never leave this device. Lantern makes no network requests except for the app itself and the model weights listed here.</p>
  <section class="card">
    <h3>Models</h3>
    <p class="small"><strong>You do not need to download anything here.</strong> Lantern downloads each model by itself the first time a show needs it, and the analysis panel in the editor shows the download. Features are switched on per show: generative fill, for example, is a switch on the Make screen and in the editor's Show tab. Use the buttons below only to fetch a model ahead of time (before going offline, say) or to free space.</p>
    <p class="dim small">Weights are verified against a pinned checksum before use and stay in this browser's storage.</p>
    <table>
      <thead><tr><th>Model</th><th>Task</th><th>License</th><th>Size</th><th></th></tr></thead>
      {#each groups as g (g.w)}
      <tbody>
        <tr class="grp"><td colspan="5">{WHEN[g.w]}</td></tr>
        {#each g.models as m (m.id)}
          <tr class:unused={m.when === "unused"}>
            <td><a href={m.source} target="_blank" rel="noreferrer">{m.name}</a>{#if m.note}<div class="dim small">{m.note}</div>{/if}</td>
            <td>{m.task}</td><td>{m.license}</td><td>{m.bytes ? fmtBytes(m.bytes) : "?"}</td>
            <td>
              {#if status[m.id]?.cached}<span class="ok">downloaded</span> <button class="ghost small" onclick={() => del(m.id)}>Delete</button>
              {:else if m.when === "unused"}<span class="dim small">not used yet</span>
              {:else}<button class="small" disabled={busy === m.id || !m.bytes} onclick={() => download(m.id)}>{busy === m.id ? "Downloading…" : "Download now"}</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
      {/each}
    </table>
  </section>
  <section class="card">
    <h3>Storage</h3>
    {#if store}<p>{fmtBytes(store.usage)} used of {fmtBytes(store.quota)} available{store.persisted ? " (persistent)" : ""}.</p>{/if}
    <div class="row">
      <button onclick={async () => { await analysisDb.clear(); app.restartAnalysis(); cleared = true; await refresh(); }} title="Forget every analysis result; each show analyses its photos again when opened">Clear analysis cache</button>
      {#if cleared}<span class="dim small">Cleared. Shows analyse their photos again when opened{app.project ? `, starting now with “${app.project.title}”` : ""}.</span>{/if}
      {#if !confirmWipe}<button class="danger" onclick={() => (confirmWipe = true)}>Delete everything…</button>
      {:else}<button class="danger" onclick={async () => { await wipeEverything(); await clearAll(); confirmWipe = false; await refresh(); }}>Yes, delete all projects and media</button><button onclick={() => (confirmWipe = false)}>Cancel</button>{/if}
    </div>
  </section>
  {#if caps}
    <section class="card">
      <h3>This device</h3>
      <p>Tier: <strong>{caps.tier}</strong> · WebGPU {caps.webgpu ? "yes" : "no"} · WebGL2 {caps.webgl2 ? "yes" : "no"} · WebCodecs {caps.webcodecs ? "yes" : "no"} · OPFS {caps.opfs ? "yes" : "no"} · cross-origin isolated {caps.isolated ? "yes" : "no"} · {caps.threads} threads · ~{caps.memory} GB</p>
    </section>
  {/if}
</div>

<style>
  .page { max-width: 880px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
  header a { color: var(--text); text-decoration: none; font-weight: 600; }
  .trust { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 6px; }
  td { padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: top; }
  .ok { color: var(--ok); }
  .grp td { color: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding-top: 14px; border-top: 0; }
  tr.unused td { opacity: .55; }
</style>
