<script lang="ts">
  // Inspector (spec §11.2): the selected slide, or the show, or a song.
  import Seg from "../ui/Seg.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Framing from "./Framing.svelte";
  import { app } from "$lib/store/project.svelte";
  import { STYLES } from "$lib/planner/styles";
  import { ASPECTS, DEPTH_TREATMENTS, TRANSITION_NAMES, TREATMENTS, TREATMENT_NAMES, type Aspect, type FillId, type Fps, type LockField, type OrderMode, type OutHeight, type Slide, type TransitionId, type TreatmentId } from "$lib/planner/types";
  import { fmtClock } from "$lib/util/math";
  let tab = $state<"slide" | "show" | "music">("slide");
  const slide = $derived(app.project?.slides.find((s) => s.id === app.selected[0]) ?? null);
  const multi = $derived(app.selected.length > 1);
  const media = $derived(slide && slide.items[0] ? app.analysis.get(slide.items[0]) : null);
  const style = $derived(app.style);
  let framing = $state(false);
  $effect(() => { if (slide) tab = "slide"; });

  const lock = (field: LockField) => (slide?.locks[field] ? "on" : "");
  function set(fn: (s: Slide) => void, fields: LockField[]) {
    if (!slide) return;
    const ids = multi ? app.selected : [slide.id];
    app.edit((p) => { for (const s of p.slides) if (ids.includes(s.id)) { fn(s); for (const f of fields) s.locks[f] = true; } });
  }
  const treatments = $derived(TREATMENTS.filter((t) => !DEPTH_TREATMENTS.has(t) || media?.depth).map((t) => ({ v: t, label: TREATMENT_NAMES[t] })));
  const transitions: TransitionId[] = ["cut", "crossfade", "dipBlack", "dipWhite", "push", "whip"];
  const fills: { v: FillId; label: string }[] = [{ v: "cover", label: "Cover" }, { v: "blur", label: "Blur" }, { v: "tilt", label: "Tilt" }];
  const beatLen = $derived(app.timeline?.beats.length ? (app.timeline.beats[app.timeline.beats.length - 1] - app.timeline.beats[0]) / Math.max(1, app.timeline.beats.length - 1) : 0);
</script>

<div class="insp">
  <div class="tabs">
    <button class:on={tab === "slide"} onclick={() => (tab = "slide")}>Slide</button>
    <button class:on={tab === "show"} onclick={() => (tab = "show")}>Show</button>
    <button class:on={tab === "music"} onclick={() => (tab = "music")}>Music</button>
  </div>
  {#if tab === "slide"}
    {#if !slide}<p class="dim">Select a slide in the storyboard.</p>
    {:else}
      {#if multi}<p class="dim small">{app.selected.length} slides selected: changes apply to all.</p>{/if}
      {#if media}<p class="small dim">{media.info.name} · {media.info.w}×{media.info.h}{#if media.faces} · {media.faces.filter((f) => f.score >= 0.5).length} face{media.faces.filter((f) => f.score >= 0.5).length === 1 ? "" : "s"}{/if}</p>{/if}
      <div class="field">
        <span class="lbl">Duration <button class="lock {lock('dur')}" onclick={() => app.unlock(slide.id, "dur")} title="Unlock">🔒</button></span>
        <div class="row">
          <input type="range" min="0.4" max="15" step="0.1" value={slide.dur} oninput={(e) => set((s) => (s.dur = Number((e.currentTarget as HTMLInputElement).value)), ["dur"])} />
          <span class="val">{slide.dur.toFixed(1)} s{#if beatLen} · {(slide.dur / beatLen).toFixed(1)} beats{/if}</span>
        </div>
      </div>
      {#if slide.kind !== "title"}
        <div class="field">
          <span class="lbl">Motion <button class="lock {lock('treatment')}" onclick={() => app.unlock(slide.id, "treatment")} title="Unlock">🔒</button></span>
          <select value={slide.treatment.id} onchange={(e) => app.setTreatment(slide, (e.currentTarget as HTMLSelectElement).value as TreatmentId)}>
            {#each treatments as t}<option value={t.v}>{t.label}</option>{/each}
          </select>
          <div class="row">
            <span class="dim small">Amount</span>
            <input type="range" min="0.2" max="1.5" step="0.05" value={slide.treatment.amount} onchange={(e) => app.setTreatment(slide, slide.treatment.id, Number((e.currentTarget as HTMLInputElement).value))} />
            <button class="small" onclick={() => app.setTreatment(slide, slide.treatment.id, slide.treatment.amount, -(slide.treatment.direction ?? 1))}>Flip</button>
          </div>
          <div class="row">
            <button class="small" onclick={() => app.tryAnother(slide)} disabled={!slide.auto.alternates.length}>Try another</button>
            <button class="small" onclick={() => (framing = !framing)}>{framing ? "Done framing" : "Edit framing"}</button>
          </div>
        </div>
        {#if framing && media}<Framing {slide} {media} />{/if}
        <Seg label="Fill" options={fills} value={slide.fill} onchange={(v) => set((s) => (s.fill = v), ["fill"])} />
      {/if}
      <div class="field">
        <span class="lbl">Transition in <button class="lock {lock('transition')}" onclick={() => app.unlock(slide.id, "transition")} title="Unlock">🔒</button></span>
        <div class="row">
          <select value={slide.transitionIn.type} onchange={(e) => set((s) => (s.transitionIn.type = (e.currentTarget as HTMLSelectElement).value as TransitionId), ["transition"])}>
            {#each transitions as t}<option value={t}>{TRANSITION_NAMES[t]}</option>{/each}
          </select>
          <input type="range" min="0" max="3" step="0.1" value={slide.transitionIn.dur} onchange={(e) => set((s) => (s.transitionIn.dur = Number((e.currentTarget as HTMLInputElement).value)), ["transition"])} />
          <span class="val">{slide.transitionIn.dur.toFixed(1)} s</span>
        </div>
      </div>
      <div class="field">
        <span class="lbl">Caption <button class="lock {lock('caption')}" onclick={() => app.unlock(slide.id, "caption")} title="Unlock">🔒</button></span>
        <input value={slide.caption?.text ?? ""} placeholder="Text shown on this slide" onchange={(e) => { const text = (e.currentTarget as HTMLInputElement).value; set((s) => { s.caption = text ? { ...(s.caption ?? { position: "bottom", style: s.kind === "title" ? "title" : "plain" }), text } : undefined; }, ["caption"]); }} />
        {#if slide.caption?.text && slide.kind !== "title"}
          <Seg label="" options={[{ v: "top", label: "Top" }, { v: "center", label: "Centre" }, { v: "bottom", label: "Bottom" }] as const} value={slide.caption.position} onchange={(v) => set((s) => { if (s.caption) s.caption.position = v; }, ["caption"])} />
        {/if}
      </div>
      {#if slide.kind === "video" && slide.clip && media?.info.duration}
        <div class="field">
          <span class="lbl">Clip</span>
          <div class="row"><span class="dim small">In</span><input type="range" min="0" max={media.info.duration - 0.5} step="0.1" value={slide.clip.in} onchange={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); set((s) => { if (s.clip) { s.clip.in = v; s.clip.out = Math.min(media.info.duration!, v + s.dur); } }, ["items"]); }} /><span class="val">{fmtClock(slide.clip.in)}</span></div>
          <Toggle label="Clip sound" help="Music ducks under it" on={slide.clip.gain > 0} onchange={(v) => set((s) => { if (s.clip) s.clip.gain = v ? 1 : 0; }, ["items"])} />
        </div>
      {/if}
      <div class="row">
        <button class="small" onclick={() => app.edit((p) => { p.starred = p.starred.includes(slide.items[0]) ? p.starred.filter((h) => h !== slide.items[0]) : [...p.starred, slide.items[0]]; })} disabled={slide.kind === "title"}>{app.project?.starred.includes(slide.items[0]) ? "★ Starred" : "☆ Star"}</button>
        <button class="small danger" onclick={() => app.edit((p) => { p.slides = p.slides.filter((s) => !app.selected.includes(s.id)); for (const s of app.project!.slides) if (app.selected.includes(s.id)) p.excluded.push(...s.items); app.selected = []; })}>Remove</button>
      </div>
      <details>
        <summary class="dim small">Why? ({slide.auto.reasons.length})</summary>
        <ul class="small dim">{#each slide.auto.reasons as r}<li>{r}</li>{/each}</ul>
      </details>
    {/if}
  {:else if tab === "show" && app.project && style}
    <div class="field"><span class="lbl">Style</span>
      <select value={app.project.styleId} onchange={(e) => app.edit((p) => { p.styleId = (e.currentTarget as HTMLSelectElement).value; }, undefined, { replan: true })}>
        {#each STYLES as s}<option value={s.id}>{s.name}</option>{/each}
      </select>
      <span class="dim small">{style.blurb}</span>
    </div>
    <div class="field"><span class="lbl">Pace</span>
      <div class="row"><input type="range" min="1.2" max="9" step="0.1" value={style.pace.base} onchange={(e) => app.edit((p) => { p.styleOverrides.pace = { ...style.pace, base: Number((e.currentTarget as HTMLInputElement).value) }; }, undefined, { replan: true })} /><span class="val">{style.pace.base.toFixed(1)} s</span></div>
    </div>
    <Seg label="Order" options={[{ v: "time", label: "Time" }, { v: "story", label: "Story" }, { v: "manual", label: "Manual" }, { v: "shuffle", label: "Shuffle" }] as { v: OrderMode; label: string }[]} value={app.project.order} onchange={(v) => app.edit((p) => { p.order = v; }, undefined, { replan: true })} />
    <Seg label="Music fit" options={[{ v: "show-to-music", label: "Show to music", help: "The show ends with the music." }, { v: "music-to-show", label: "Music to show", help: "Durations as planned; music fades at the end." }, { v: "free", label: "Free" }] as const} value={app.project.fit} onchange={(v) => app.edit((p) => { p.fit = v; }, undefined, { replan: true })} />
    <Seg label="Beat sync" options={[{ v: "off", label: "Off" }, { v: "cuts", label: "Cuts" }, { v: "cuts+accents", label: "Cuts + accents" }] as const} value={style.beatSync} onchange={(v) => app.edit((p) => { p.styleOverrides.beatSync = v; }, undefined, { replan: true })} />
    <div class="field"><span class="lbl">Titles</span>
      <input placeholder="Opening title" value={app.project.titles.intro ?? ""} onchange={(e) => app.edit((p) => { p.titles.intro = (e.currentTarget as HTMLInputElement).value || undefined; }, undefined, { replan: true })} />
      <input placeholder="Closing title" value={app.project.titles.end ?? ""} onchange={(e) => app.edit((p) => { p.titles.end = (e.currentTarget as HTMLInputElement).value || undefined; }, undefined, { replan: true })} />
      <Toggle label="Chapter cards" help="A date card where the capture time jumps" on={app.project.titles.chapters} onchange={(v) => app.edit((p) => { p.titles.chapters = v; }, undefined, { replan: true })} />
    </div>
    <div class="field"><span class="lbl">Output</span>
      <Seg label="" options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ v: a, label: a }))} value={app.project.output.aspect} onchange={(v) => app.setOutput({ aspect: v })} />
      <div class="row">
        <select value={app.project.output.height} onchange={(e) => app.setOutput({ height: Number((e.currentTarget as HTMLSelectElement).value) as OutHeight })}>{#each [720, 1080, 1440, 2160] as h}<option value={h}>{h}p</option>{/each}</select>
        <select value={app.project.output.fps} onchange={(e) => app.setOutput({ fps: Number((e.currentTarget as HTMLSelectElement).value) as Fps })}>{#each [24, 30, 60] as f}<option value={f}>{f} fps</option>{/each}</select>
      </div>
    </div>
    <div class="field"><span class="lbl">Depth</span>
      <div class="row"><span class="dim small">3D strength</span><input type="range" min="0" max="1.5" step="0.05" value={app.project.depthStrength} onchange={(e) => app.edit((p) => { p.depthStrength = Number((e.currentTarget as HTMLInputElement).value); }, undefined, { replan: true })} /></div>
      <span class="dim small">3D moves use each photo's depth map once its analysis has arrived; photos without relief stay 2D.</span>
    </div>
    <button onclick={() => app.replan({ newSeed: true })}>Re-roll (new seed, locks kept)</button>
    {#if app.planResult?.warnings.length}<div class="warn">{#each app.planResult.warnings as w}<div>{w}</div>{/each}</div>{/if}
  {:else if tab === "music" && app.project}
    {#each app.project.songs as song, i (song.hash)}
      {@const a = app.music.get(song.hash)}
      {@const info = app.songs.get(song.hash)}
      <div class="card col">
        <strong>{info?.info.name ?? song.hash}</strong>
        {#if a}
          <span class="dim small">{fmtClock(a.duration)} · {Math.round(a.tempo)} BPM ({a.beatsPerBar}/4) · {a.sections.length} sections · loudness {a.loudness.toFixed(0)} dB</span>
          <div class="row"><span class="dim small">Tempo</span>
            <button class="small" onclick={() => app.edit((p) => { a.tempo = a.tempoAlt; }, undefined, { replan: true })}>Use {Math.round(a.tempoAlt)} BPM</button>
            <button class="small" onclick={() => app.edit(() => { a.offset = Math.round((a.offset + 0.02) * 1000) / 1000; }, undefined, { replan: true })}>Grid +20 ms</button>
            <button class="small" onclick={() => app.edit(() => { a.offset = Math.round((a.offset - 0.02) * 1000) / 1000; }, undefined, { replan: true })}>−20 ms</button>
          </div>
        {:else}<span class="dim small">Analysing…</span>{/if}
        <div class="row"><span class="dim small">Trim in</span><input type="range" min="0" max={Math.max(0, (info?.info.duration ?? 0) - 10)} step="0.5" value={song.trimIn} onchange={(e) => app.edit((p) => { p.songs[i].trimIn = Number((e.currentTarget as HTMLInputElement).value); }, undefined, { replan: true })} /><span class="val">{fmtClock(song.trimIn)}</span></div>
        <div class="row"><span class="dim small">Trim out</span><input type="range" min="0" max={info?.info.duration ?? 0} step="0.5" value={song.trimOut || (info?.info.duration ?? 0)} onchange={(e) => app.edit((p) => { p.songs[i].trimOut = Number((e.currentTarget as HTMLInputElement).value); }, undefined, { replan: true })} /><span class="val">{fmtClock(song.trimOut || (info?.info.duration ?? 0))}</span></div>
        <div class="row"><span class="dim small">Gain</span><input type="range" min="0" max="2" step="0.05" value={song.gain} onchange={(e) => app.edit((p) => { p.songs[i].gain = Number((e.currentTarget as HTMLInputElement).value); })} /></div>
        <div class="row"><span class="dim small">Fade out</span><input type="range" min="0" max="10" step="0.5" value={song.fadeOut} onchange={(e) => app.edit((p) => { p.songs[i].fadeOut = Number((e.currentTarget as HTMLInputElement).value); })} /><span class="val">{song.fadeOut} s</span></div>
        <div class="row">
          {#if i > 0}<button class="small" onclick={() => app.edit((p) => { [p.songs[i - 1], p.songs[i]] = [p.songs[i], p.songs[i - 1]]; }, undefined, { replan: true })}>↑</button>{/if}
          <button class="small danger" onclick={() => app.edit((p) => { p.songs.splice(i, 1); }, undefined, { replan: true })}>Remove</button>
        </div>
      </div>
    {/each}
    {#if !app.project.songs.length}<p class="dim">No music. Add songs from the library drawer.</p>{/if}
  {/if}
</div>

<style>
  .insp { display: flex; flex-direction: column; gap: 12px; padding: 10px; overflow-y: auto; height: 100%; }
  .tabs { display: flex; gap: 4px; }
  .tabs button { flex: 1; }
  .tabs button.on { background: #2a2a44; }
  .val { font-size: 12px; color: var(--dim); min-width: 70px; text-align: right; font-variant-numeric: tabular-nums; }
  .row input[type="range"] { flex: 1; width: auto; }
  .warn { color: var(--accent); font-size: 13px; }
  ul { margin: 4px 0 0; padding-left: 18px; }
</style>
