<script lang="ts" generics="T">
  // Segmented choice with a label and an optional one-line explanation of the chosen option.
  let { label, options, value, onchange, wrap = false }:
    { label: string; options: readonly { v: T; label: string; help?: string }[]; value: T; onchange: (v: T) => void; wrap?: boolean } = $props();
  const help = $derived(options.find((o) => o.v === value)?.help);
</script>

<div class="seg">
  {#if label}<div class="label">{label}</div>{/if}
  <div class="opts" class:wrap role="radiogroup" aria-label={label}>
    {#each options as o (o.label)}
      <button role="radio" aria-checked={o.v === value} class:on={o.v === value} onclick={() => onchange(o.v)}>{o.label}</button>
    {/each}
  </div>
  {#if help}<div class="help">{help}</div>{/if}
</div>

<style>
  .seg { display: flex; flex-direction: column; gap: 5px; }
  .label { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
  .opts { display: flex; gap: 3px; padding: 3px; background: #111116; border-radius: 10px; border: 1px solid var(--line); }
  .opts button { flex: 1; border: 0; background: transparent; padding: 6px 6px; border-radius: 8px; white-space: nowrap; font-size: 13px; }
  .opts.wrap { flex-wrap: wrap; }
  .opts.wrap button { flex: 1 0 auto; }
  .opts button.on { background: #2a2a44; color: #fff; }
  .help { font-size: 12px; color: var(--dim); min-height: 1.2em; }
</style>
