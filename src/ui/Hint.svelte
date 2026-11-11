<script lang="ts">
  import { onMount } from "svelte";
  // A short reminder that fades by itself.
  let { lines }: { lines: string[] } = $props();
  let show = $state(true);
  onMount(() => { const t = setTimeout(() => (show = false), 4500); return () => clearTimeout(t); });
</script>

{#if show}
  <div class="hint" aria-live="polite">{#each lines as l}<div>{l}</div>{/each}</div>
{/if}

<style>
  .hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 26; pointer-events: none; padding: 12px 16px; border-radius: 12px; background: rgba(0,0,0,.6); line-height: 1.7; text-align: center; animation: fade 4.5s ease-in-out forwards; }
  @keyframes fade { 0% { opacity: 0; } 8% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: 0; } }
</style>
