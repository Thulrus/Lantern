<script lang="ts">
  // A labelled on/off row with a short explanation.
  let { label, help = "", on, onchange }: { label: string; help?: string; on: boolean; onchange: (v: boolean) => void } = $props();
</script>

<button class="toggle" role="switch" aria-checked={on} onclick={() => onchange(!on)}>
  <span class="text"><span>{label}</span>{#if help}<span class="help">{help}</span>{/if}</span>
  <span class="sw" class:on><span></span></span>
</button>

<style>
  .toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left; background: transparent; border: 0; padding: 5px 0; }
  .text { display: flex; flex-direction: column; }
  .help { font-size: 12px; color: var(--dim); }
  .sw { flex: none; width: 40px; height: 24px; border-radius: 12px; background: #2a2a30; position: relative; transition: background .15s; }
  .sw span { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #ccc; transition: transform .15s; }
  .sw.on { background: var(--accent); }
  .sw.on span { transform: translateX(16px); background: #fff; }
</style>
