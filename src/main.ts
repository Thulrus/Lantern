import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").then((reg) => {
    // First visit: the worker's COOP/COEP headers apply from the next load. Reload once to get
    // cross-origin isolation (multi-threaded WASM) without the user noticing.
    if (!crossOriginIsolated && !sessionStorage.getItem("lantern-coi-reload") && reg.active === null) {
      reg.addEventListener("updatefound", () => {
        reg.installing?.addEventListener("statechange", (e) => {
          if ((e.target as ServiceWorker).state === "activated" && !crossOriginIsolated) {
            sessionStorage.setItem("lantern-coi-reload", "1");
            location.reload();
          }
        });
      });
    }
  }).catch(() => { /* no service worker: the app still works, just not offline */ });
}

mount(App, { target: document.getElementById("app")! });
