<script lang="ts">
  // Save the show as a .lantern project file (spec §8.1), to open it in another browser or on another machine.
  import Sheet from "../ui/Sheet.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { app } from "$lib/store/project.svelte";
  import { buildPackage, savePackage } from "$lib/store/package";
  import { fmtBytes } from "$lib/util/math";
  let { onclose }: { onclose: () => void } = $props();
  let analysis = $state(true);
  let originals = $state(true);
  let busy = $state<{ share: number; step: string } | null>(null);
  let done = $state<string | null>(null);
  let error = $state<string | null>(null);

  const originalBytes = $derived.by(() => {
    const p = app.project;
    if (!p) return 0;
    let n = 0;
    for (const h of p.media) n += app.records.get(h)?.info.bytes ?? 0;
    for (const s of p.songs) n += app.songs.get(s.hash)?.info.bytes ?? 0;
    return n;
  });

  async function run() {
    if (!app.project) return;
    error = null; done = null; busy = { share: 0, step: "Starting" };
    try {
      await app.saveNow();
      const r = await buildPackage($state.snapshot(app.project), { analysis, originals }, (share, step) => (busy = { share, step }));
      busy = { share: 1, step: "Saving" };
      await savePackage(r);
      done = `Saved ${r.fileName} (${fmtBytes(r.blob.size)}).` + (r.missingOriginals.length ? ` ${r.missingOriginals.length} original file${r.missingOriginals.length > 1 ? "s were" : " was"} not readable and went in as ${r.missingOriginals.length > 1 ? "proxies" : "a proxy"}: ${r.missingOriginals.slice(0, 3).join(", ")}${r.missingOriginals.length > 3 ? "…" : ""}.` : "");
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }
</script>

<Sheet title="Save project file" {onclose}>
  <p class="dim small">A <b>.lantern</b> file holds this show with its edits, so you can open it in another browser or on another computer (Start screen → Open project file). It stays on your device like everything else; nothing is uploaded.</p>
  <Toggle label="Include analysis" help="Faces, depth and fills, so the other browser does not analyse the photos again" on={analysis} onchange={(v) => (analysis = v)} />
  <Toggle label="Include original files" help={`Full-quality photos, videos and songs${originalBytes ? ` (about ${fmtBytes(originalBytes)})` : ""}. Off: photos travel as 2560 px proxies and the songs stay behind`} on={originals} onchange={(v) => (originals = v)} />
  {#if busy}
    <div class="col">
      <div>{busy.step}…</div>
      <progress value={busy.share} max="1"></progress>
    </div>
  {:else}
    <button class="primary" onclick={run} disabled={!app.project}>Save project file</button>
  {/if}
  {#if done}<p class="ok">{done}</p>{/if}
  {#if error}<p class="warn">{error}</p>{/if}
</Sheet>

<style>
  .warn { color: var(--danger); } .ok { color: var(--ok); }
  progress { width: 100%; accent-color: var(--accent); }
</style>
