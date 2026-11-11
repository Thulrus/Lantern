<script lang="ts">
  // Drag-and-drop and pickers for photos, videos and songs (spec §4.1).
  import type { Snippet } from "svelte";
  import { collectFiles, walkDirHandle } from "$lib/media/import";
  let { onfiles, children, compact = false }: { onfiles: (files: { file: File; handle?: FileSystemFileHandle }[]) => void; children?: Snippet; compact?: boolean } = $props();
  let over = $state(false);
  let input: HTMLInputElement;
  let folderInput: HTMLInputElement;
  const hasDirPicker = "showDirectoryPicker" in window;

  async function drop(e: DragEvent) {
    e.preventDefault(); over = false;
    if (!e.dataTransfer) return;
    onfiles(await collectFiles(e.dataTransfer.items));
  }
  async function pickFolder() {
    if (hasDirPicker) {
      try {
        const dir = await (window as unknown as { showDirectoryPicker: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "read" });
        const out: { file: File; handle?: FileSystemFileHandle }[] = [];
        await walkDirHandle(dir, out);
        onfiles(out);
      } catch { /* cancelled */ }
    } else folderInput.click();
  }
</script>

<div class="zone" class:over class:compact role="region" aria-label="Add photos, videos and songs"
  ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
  {#if children}{@render children()}{:else}
    <div class="big">Drop photos, videos and songs here</div>
    <div class="dim">or</div>
  {/if}
  <div class="row">
    <button onclick={() => input.click()}>Choose files</button>
    <button onclick={pickFolder}>Choose a folder</button>
  </div>
  <input bind:this={input} type="file" multiple hidden accept="image/*,video/*,audio/*,.heic,.heif" onchange={async (e) => { const f = (e.currentTarget as HTMLInputElement).files; if (f) onfiles(await collectFiles(f)); (e.currentTarget as HTMLInputElement).value = ""; }} />
  <input bind:this={folderInput} type="file" multiple hidden webkitdirectory onchange={async (e) => { const f = (e.currentTarget as HTMLInputElement).files; if (f) onfiles(await collectFiles(f)); }} />
</div>

<style>
  .zone { border: 2px dashed var(--line); border-radius: 14px; padding: 28px; display: flex; flex-direction: column; align-items: center; gap: 10px; transition: border-color .15s, background .15s; }
  .zone.compact { padding: 12px; flex-direction: row; justify-content: center; }
  .zone.over { border-color: var(--accent); background: #f3b64b12; }
  .big { font-size: 17px; }
</style>
