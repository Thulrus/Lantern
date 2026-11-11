<script lang="ts">
  import { onMount } from "svelte";
  import { MODELS } from "$lib/models/registry";
  import { deleteModel, fetchModel, modelStatus, type ModelStatus } from "$lib/models/fetch";
  import { clearAll, storageEstimate } from "$lib/store/opfs";
  import { analysisDb, wipeEverything } from "$lib/store/db";
  import { detect, type Capabilities } from "$lib/media/tier";
  import { fmtBytes } from "$lib/util/math";
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
    <p class="dim small">Every model, its size, license and whether it is downloaded. Weights are verified against a pinned checksum before use.</p>
    <table>
      <thead><tr><th>Model</th><th>Task</th><th>License</th><th>Size</th><th></th></tr></thead>
      <tbody>
        {#each MODELS as m (m.id)}
          <tr>
            <td><a href={m.source} target="_blank" rel="noreferrer">{m.name}</a>{#if m.note}<div class="dim small">{m.note}</div>{/if}</td>
            <td>{m.task}</td><td>{m.license}</td><td>{m.bytes ? fmtBytes(m.bytes) : "?"}</td>
            <td>
              {#if status[m.id]?.cached}<span class="ok">downloaded</span> <button class="ghost small" onclick={() => del(m.id)}>Delete</button>
              {:else}<button class="small" disabled={busy === m.id || !m.bytes} onclick={() => download(m.id)}>{busy === m.id ? "Downloading…" : "Download"}</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
  <section class="card">
    <h3>Storage</h3>
    {#if store}<p>{fmtBytes(store.usage)} used of {fmtBytes(store.quota)} available{store.persisted ? " (persistent)" : ""}.</p>{/if}
    <div class="row">
      <button onclick={async () => { await analysisDb.clear(); await refresh(); }}>Clear analysis cache</button>
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
</style>
