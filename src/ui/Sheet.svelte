<script lang="ts">
  import type { Snippet } from "svelte";
  // A modal sheet: bottom sheet on phones, centred dialog on wide screens.
  let { title, onclose, children, wide = false }: { title: string; onclose: () => void; children: Snippet; wide?: boolean } = $props();
  const stop = (e: Event) => e.stopPropagation();
</script>

<div class="scrim" role="presentation" onpointerdown={stop} onpointerup={(e) => { stop(e); onclose(); }}></div>
<div class="sheet" class:wide role="dialog" tabindex="-1" aria-label={title} onpointerdown={stop} onpointerup={stop}>
  <header><strong>{title}</strong><button class="ghost" onclick={onclose} aria-label="Close">✕</button></header>
  <div class="body">{@render children()}</div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 30; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 31; max-height: 85vh; display: flex; flex-direction: column;
    background: rgba(20, 20, 27, .97); backdrop-filter: blur(12px); border-radius: 18px 18px 0 0; border-top: 1px solid var(--line);
    padding-bottom: env(safe-area-inset-bottom); animation: up .18s ease-out; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
  .body { overflow-y: auto; padding: 4px 16px 18px; display: flex; flex-direction: column; gap: 14px; }
  @media (min-width: 760px) {
    .sheet { left: 50%; right: auto; top: 50%; bottom: auto; transform: translate(-50%, -50%); width: 460px; max-height: 88vh; border-radius: 16px; border: 1px solid var(--line); animation: none; }
    .sheet.wide { width: 720px; }
  }
  @keyframes up { from { transform: translateY(30%); opacity: 0; } }
</style>
