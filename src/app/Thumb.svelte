<script lang="ts">
  // A media thumbnail from OPFS, as an object URL that is revoked when the component goes away.
  import { onDestroy } from "svelte";
  import { getFile } from "$lib/store/opfs";
  let { hash, alt = "" }: { hash: string; alt?: string } = $props();
  let url = $state<string | null>(null);
  let last = "";
  $effect(() => {
    if (hash === last) return;
    last = hash;
    getFile(hash, "thumb.webp").then((b) => { if (url) URL.revokeObjectURL(url); url = b ? URL.createObjectURL(b) : null; });
  });
  onDestroy(() => { if (url) URL.revokeObjectURL(url); });
</script>

{#if url}<img src={url} {alt} loading="lazy" draggable="false" />{:else}<div class="ph"></div>{/if}

<style>
  img, .ph { width: 100%; height: 100%; object-fit: cover; display: block; background: #0a0a0e; }
</style>
