// Grove PWA service worker.
// Hand-rolled (no Workbox, no vite-plugin-pwa) to satisfy Chrome's
// install-prompt criteria. Strategy: instant takeover on update,
// network-first navigations to avoid stale HTML, pass-through for
// everything else (Vite content-hashes assets, so the browser cache
// handles them correctly).

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-cache" }));
  }
  // else: pass through (let the browser handle)
});
