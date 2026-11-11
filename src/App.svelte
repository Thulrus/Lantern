<script lang="ts">
  import { onMount } from "svelte";
  import Start from "./app/Start.svelte";
  import Make from "./app/Make.svelte";
  import Editor from "./app/Editor.svelte";
  import Settings from "./app/Settings.svelte";
  import Bench from "./app/Bench.svelte";
  import { app } from "$lib/store/project.svelte";

  type Route = { page: "start" } | { page: "make"; id: string } | { page: "edit"; id: string } | { page: "settings" } | { page: "bench" };
  let route = $state<Route>({ page: "start" });

  function parse(): Route {
    const h = location.hash.replace(/^#\/?/, "");
    const [page, id] = h.split("/");
    if (page === "make" && id) return { page: "make", id };
    if (page === "edit" && id) return { page: "edit", id };
    if (page === "settings") return { page: "settings" };
    if (page === "bench") return { page: "bench" };
    return { page: "start" };
  }
  onMount(() => {
    route = parse();
    const on = () => (route = parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  });
  export function go(to: string) { location.hash = "#/" + to; }
</script>

{#if route.page === "start"}<Start />
{:else if route.page === "make"}<Make id={route.id} />
{:else if route.page === "edit"}<Editor id={route.id} />
{:else if route.page === "settings"}<Settings />
{:else if route.page === "bench"}<Bench />
{/if}

{#if app.toast}<div class="toast">{app.toast}</div>{/if}
