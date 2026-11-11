<script lang="ts">
  import { onMount } from "svelte";
  import Sheet from "../ui/Sheet.svelte";
  import Seg from "../ui/Seg.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { app } from "$lib/store/project.svelte";
  import { exportCapabilities, exportVideo, type ExportCapabilities, type ExportProgress } from "$lib/export/export";
  import { fmtBytes, fmtClock } from "$lib/util/math";
  let { onclose }: { onclose: () => void } = $props();
  let caps = $state<ExportCapabilities | null>(null);
  let quality = $state<"standard" | "high" | "max">("high");
  let motionBlur = $state(false);
  let saveTo = $state<"picker" | "download">("picker");
  let progress = $state<ExportProgress | null>(null);
  let result = $state<{ fileName: string; bytes: number; codec: string } | null>(null);
  let error = $state<string | null>(null);
  let abort: AbortController | null = null;
  let wake: { release: () => Promise<void> } | null = null;
  onMount(async () => { const [w, h] = app.timeline?.size ?? [1920, 1080]; caps = await exportCapabilities(w, h); });

  async function run() {
    const tl = app.timeline;
    if (!tl || !app.project) return;
    error = null; result = null; abort = new AbortController();
    try { wake = await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch { wake = null; }
    try {
      const r = await exportVideo(tl, { quality, motionBlur, fileName: app.project.title || "lantern-show", saveTo }, (p) => (progress = p), abort.signal);
      result = r;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (error === "cancelled") error = null;
    } finally {
      progress = null;
      await wake?.release().catch(() => {});
    }
  }
  const draft = $derived(app.project?.slides.filter((s) => s.kind !== "title" && !app.analysis.get(s.items[0])?.faces).length ?? 0);
</script>

<Sheet title="Export video" {onclose}>
  {#if app.timeline}
    <p class="dim small">{app.timeline.size[0]}×{app.timeline.size[1]} · {app.timeline.fps} fps · {fmtClock(app.timeline.dur)} · {app.timeline.layers.length} slides. Change the format in the Show inspector.</p>
  {/if}
  {#if caps && !caps.webcodecs}
    <p class="warn">This browser cannot encode video (no WebCodecs). Use Chrome or Edge for export.</p>
  {:else if caps}
    <p class="dim small">Codec: {caps.video?.codec ?? "none"} in {caps.video?.container ?? "?"}{caps.audio ? ` with ${caps.audio}` : " (no audio encoder)"} · {caps.savePicker ? "streams to a file you choose" : "downloads when finished"}</p>
  {/if}
  {#if draft}<p class="dim small">{draft} slides are still waiting for face analysis; exporting now uses their draft framing.</p>{/if}
  <Seg label="Quality" options={[{ v: "standard", label: "Standard" }, { v: "high", label: "High" }, { v: "max", label: "Max" }] as const} value={quality} onchange={(v) => (quality = v)} />
  {#if caps?.savePicker}<Toggle label="Choose where to save" help="Off: the file downloads when finished" on={saveTo === "picker"} onchange={(v) => (saveTo = v ? "picker" : "download")} />{/if}
  <Toggle label="Motion blur" help="4 sub-frames per frame: smoother slow pans, 4× slower export" on={motionBlur} onchange={(v) => (motionBlur = v)} />
  {#if progress}
    <div class="col">
      <div>{progress.stage === "audio" ? "Mixing audio…" : progress.stage === "video" ? `Rendering frame ${progress.frame} of ${progress.frames}` : progress.stage === "finish" ? "Finishing the file…" : "Preparing…"}</div>
      <progress value={progress.frame} max={progress.frames}></progress>
      <div class="dim small">{progress.codec}{progress.eta ? ` · about ${fmtClock(progress.eta)} left` : ""} · keep this tab visible for full speed</div>
      <button onclick={() => abort?.abort()}>Cancel</button>
    </div>
  {:else}
    <button class="primary" onclick={run} disabled={!caps?.webcodecs || !app.timeline}>Export</button>
  {/if}
  {#if result}<p class="ok">Saved {result.fileName}{result.bytes ? ` (${fmtBytes(result.bytes)})` : ""} with {result.codec}.</p>{/if}
  {#if error}<p class="warn">{error}</p>{/if}
</Sheet>

<style>
  .warn { color: var(--danger); } .ok { color: var(--ok); }
  progress { width: 100%; accent-color: var(--accent); }
</style>
