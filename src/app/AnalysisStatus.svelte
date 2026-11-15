<script lang="ts">
  // What the analysis is doing and what is still to come (spec §4.4): one row per stage with
  // counts, the live activity of each worker (model downloads, model loads, the photo in hand),
  // a rough time left, and what the results will change in the show. `pill` is the compact
  // header button that opens the same panel as a popover; `panel` shows it inline (Make screen).
  import { app } from "$lib/store/project.svelte";
  import { modelById } from "$lib/models/registry";
  import { modelStatus } from "$lib/models/fetch";
  import { FILL_MODEL } from "$lib/analysis/fill";
  import type { Activity, StageId } from "$lib/analysis/queue";
  import { fmtBytes } from "$lib/util/math";
  let { mode = "pill" }: { mode?: "pill" | "panel" } = $props();
  let open = $state(false);
  let confirmRerun = $state(false);
  let fillCached = $state<boolean | null>(null);
  $effect(() => { void app.project?.generativeFill; void app.activity.length; void modelStatus(FILL_MODEL).then((s) => (fillCached = s.cached)); });

  const pipe = $derived(app.pipeline());
  const style = $derived(app.style);
  const has3d = $derived((style?.depthShare ?? 0) > 0);
  const live = $derived(pipe.stages.filter((s) => s.on));
  const pct = $derived.by(() => {
    const t = live.reduce((a, s) => a + s.total, 0);
    return t ? Math.floor((100 * live.reduce((a, s) => a + s.done + s.errors, 0)) / t) : 100;
  });
  const errors = $derived(live.reduce((a, s) => a + s.errors, 0));
  const fillBytes = modelById(FILL_MODEL)?.bytes ?? 0;

  const TITLE: Record<StageId, string> = { basics: "Reading photos", faces: "Finding faces", depth: "Measuring depth", fill: "Filling behind people" };
  function about(id: StageId): string {
    if (id === "basics") return "Sharpness, exposure and near-duplicates: decides which photos to use and in what order.";
    if (id === "faces") return "Keeps faces in frame and aims the moves at people.";
    if (id === "depth") return has3d
      ? "Lets photos move in 3D. Until a photo's depth is ready it gets a 2D move, then upgrades."
      : `${style?.name ?? "This style"} has no 3D moves, so depth only helps framing. Gentle, Cinematic, Upbeat and Travel use 3D.`;
    if (app.project?.generativeFill === "all" && !has3d) return `On, but waiting: ${style?.name ?? "this style"} has no 3D moves, so a fill would never show. It runs when you pick a 3D style.`;
    return app.project?.generativeFill === "all"
      ? "Paints the background a 3D move uncovers behind people, so no blurred halo shows. The slowest step: several seconds per photo."
      : `Off. Turn it on for cleaner 3D moves around people${fillCached ? "" : ` (one-time ${fmtBytes(fillBytes)} download)`}.`;
  }
  function skippedNote(id: StageId, n: number): string {
    if (!n) return "";
    return id === "fill" ? `${n} with nothing to fill` : `${n} video${n > 1 ? "s" : ""} skipped`;
  }
  const name = (h: string) => app.records.get(h)?.info.name ?? "a photo";
  function line(a: Activity): string {
    const m = a.model ? modelById(a.model) : undefined;
    if (a.phase === "download" && m) return `Downloading the ${m.short}: ${fmtBytes((a.done ?? 0) * m.bytes)} of ${fmtBytes(m.bytes)} (once; it stays in this browser)`;
    if (a.phase === "load" && m) return `Loading the ${m.short} into memory · ${name(a.hash)}`;
    return `${a.step} · ${name(a.hash)}`;
  }
  const eta = (s: number | null) => s === null ? "" : s < 60 ? "less than a minute left" : `about ${Math.round(s / 60)} min left`;
  async function rerun() { confirmRerun = false; await app.reanalyse(); }
</script>

{#snippet body()}
  <div class="head row">
    <strong>{pipe.busy ? "Analysing your photos" : errors ? "Analysis finished with problems" : "Analysis done"}</strong>
    {#if pipe.busy}<span class="dim small">{pct}%{pipe.etaS !== null ? ` · ${eta(pipe.etaS)}` : " · estimating time…"}</span>{/if}
    {#if mode === "pill"}<button class="ghost small x" onclick={() => (open = false)} aria-label="Close">✕</button>{/if}
  </div>
  <ol class="stages">
    {#each pipe.stages as s (s.id)}
      {@const finished = s.done + s.errors >= s.total}
      <li class:off={!s.on}>
        <span class="mark" class:ok={s.on && finished && !s.errors} class:err={s.errors > 0} class:run={s.on && !finished && (s.running > 0 || s.done > 0)}>
          {#if !s.on}–{:else if finished && !s.errors}✓{:else if s.errors && finished}!{:else if s.running || s.done}<span class="spin"></span>{:else}○{/if}
        </span>
        <div class="txt">
          <div class="row t">
            <span>{TITLE[s.id]}</span>
            {#if s.on}<span class="dim small n">{s.done} of {s.total}{s.errors ? ` · ${s.errors} failed` : ""}</span>{/if}
            {#if s.id === "fill" && app.project?.generativeFill !== "all"}<button class="small" onclick={() => app.setGenerativeFill("all")}>Turn on</button>{/if}
            {#if s.id === "fill" && app.project?.generativeFill === "all"}<button class="ghost small" onclick={() => app.setGenerativeFill("off")}>Turn off</button>{/if}
          </div>
          {#if s.on && !finished}<progress value={s.done + s.errors} max={s.total}></progress>{/if}
          <div class="dim small">{about(s.id)}{#if s.on && skippedNote(s.id, s.skipped)}&nbsp;<span>({skippedNote(s.id, s.skipped)})</span>{/if}</div>
          {#if s.firstError}<div class="small errtxt">{s.firstError}</div>{/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if app.activity.length}
    <div class="now">
      <span class="lbl">Right now</span>
      {#each app.activity as a, i (i)}
        <div class="small act">
          {line(a)}
          {#if a.phase === "download"}<progress value={a.done ?? 0} max="1"></progress>{/if}
        </div>
      {/each}
    </div>
  {:else if pipe.busy}
    <div class="now small dim">Waiting for the next photo…</div>
  {/if}
  <p class="small next">
    {#if pipe.busy && !app.userEdited}You can play and edit the show already. Slides improve by themselves as results arrive.
    {:else if pipe.busy}You have edited the show, so new results wait for you: press <em>Apply new analysis</em> at the top when it appears.
    {:else if app.pendingUpgrade}New results are ready: press <em>Apply new analysis</em> at the top to use them.
    {:else}Every result is in use. Changing a style or option re-plans with what is already here.{/if}
  </p>
  <div class="row rerun">
    {#if !confirmRerun}
      <button class="small" onclick={() => (confirmRerun = true)} disabled={!app.project?.media.length}>Run analysis again…</button>
    {:else}
      <span class="small">Run faces, depth{app.project?.generativeFill === "all" ? " and fill" : ""} again for all {app.project?.media.length} items?</span>
      <button class="small primary" onclick={rerun}>Run again</button>
      <button class="small ghost" onclick={() => (confirmRerun = false)}>Cancel</button>
    {/if}
  </div>
{/snippet}

{#if mode === "panel"}
  <section class="card panel">{@render body()}</section>
{:else}
  <div class="wrap">
    <button class="pill small" class:busy={pipe.busy} class:bad={!pipe.busy && errors > 0} onclick={() => (open = !open)} aria-expanded={open} title="What the analysis is doing">
      {#if pipe.busy}<span class="spin"></span> Analysing {pct}%{pipe.etaS !== null && pipe.etaS >= 60 ? ` · ~${Math.round(pipe.etaS / 60)} min` : ""}
      {:else if errors}! Analysis: {errors} problem{errors > 1 ? "s" : ""}
      {:else}✓ Analysis done{/if}
    </button>
    {#if open}<div class="pop card">{@render body()}</div>{/if}
  </div>
{/if}

<style>
  .wrap { position: relative; }
  .pill { border-radius: 999px; padding: 4px 12px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .pill.busy { border-color: var(--accent); color: var(--accent); }
  .pill.bad { border-color: var(--danger); color: var(--danger); }
  .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 50; width: min(440px, 92vw); box-shadow: 0 10px 40px #000a; max-height: 80vh; overflow-y: auto; }
  .head { justify-content: space-between; margin-bottom: 8px; }
  .head .x { margin-left: auto; padding: 2px 8px; }
  .stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .stages li { display: flex; gap: 10px; align-items: flex-start; }
  .stages li.off .t > span:first-child { color: var(--dim); }
  .mark { flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; border: 1px solid var(--line); color: var(--dim); margin-top: 1px; }
  .mark.ok { background: var(--ok); color: #08200f; border-color: transparent; }
  .mark.err { background: var(--danger); color: #fff; border-color: transparent; }
  .mark.run { border-color: var(--accent); }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .t { justify-content: space-between; gap: 6px; }
  .t .n { margin-left: auto; font-variant-numeric: tabular-nums; }
  .t button { padding: 2px 10px; }
  progress { width: 100%; height: 6px; accent-color: var(--accent); }
  .errtxt { color: var(--danger); overflow-wrap: anywhere; }
  .now { margin-top: 12px; padding: 8px 10px; border-radius: 8px; background: var(--panel2); display: flex; flex-direction: column; gap: 4px; }
  .now .lbl { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
  .act { overflow-wrap: anywhere; }
  .next { margin: 10px 0 6px; }
  .rerun button { padding: 3px 10px; }
  .spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; display: inline-block; animation: spin .8s linear infinite; }
  .mark .spin { color: var(--accent); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
