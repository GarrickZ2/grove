// Grove PWA service worker.
// Hand-rolled (no Workbox, no vite-plugin-pwa). Sole job: satisfy
// Chrome's install-prompt criteria, which require an active SW with a
// `fetch` listener. The listener body is intentionally empty — Chrome
// only checks that a listener exists; without `respondWith` the browser
// handles every request normally (Vite's content-hashed assets cache
// correctly; the backend sets Cache-Control: no-cache on /sw.js itself).
// Plus instant takeover on update so SW updates land within one nav.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Intentionally empty — see comment at top.
});
