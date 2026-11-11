// Lantern service worker: two jobs in one scope.
//  1. Cross-origin isolation on hosts that cannot set headers (GitHub Pages): every response this
//     worker serves gets COOP/COEP, which turns on crossOriginIsolated (SharedArrayBuffer, so
//     multi-threaded WASM) after the first load. Cross-origin fetches (model weights) are passed
//     through untouched; they must carry CORS headers of their own (`credentialless` lets
//     no-cors subresources through as well).
//  2. An offline app shell: same-origin GET responses are cached as they are fetched, so the app
//     works without a network after the first visit. Model weights are cached by the app itself in
//     a separate Cache Storage bucket (see src/lib/models/fetch.ts).
const SHELL = "lantern-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("lantern-shell-") && k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isolate(res) {
  if (res.status === 0 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same) {
    // Model weights and other cross-origin fetches: pass through, nothing cached here.
    e.respondWith(fetch(req).then(isolate).catch(() => fetch(req)));
    return;
  }
  const nav = req.mode === "navigate";
  e.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      if (nav) {
        // The page itself: network first so deploys land, cache when offline.
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return isolate(res);
        } catch {
          const hit = (await cache.match(req)) ?? (await cache.match("./")) ?? (await cache.match("./index.html"));
          if (hit) return isolate(hit);
          throw new Error("offline and not cached");
        }
      }
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok && (url.pathname.includes("/assets/") || /\.(js|mjs|css|wasm|woff2|svg|json|webmanifest)$/.test(url.pathname)))
        cache.put(req, res.clone());
      return isolate(res);
    })(),
  );
});
