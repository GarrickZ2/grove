// Grove PWA service worker. Hand-rolled (no Workbox, no vite-plugin-pwa).
//
// It keeps the app's own files on the device so an installed Grove opens
// without waiting on the network:
//
// - Pages (navigations): the network first, so a good connection always gets
//   the current build. When the network fails, or hasn't answered within
//   NAV_TIMEOUT_MS, the last copy is served instead and the network answer,
//   if it still comes, refreshes the copy for next time.
// - Vite's content-hashed files under /assets/: from the copy when there is
//   one; they never change under the same name.
// - The few fixed files at the root (icons, boot theme, manifest, worklet):
//   the copy at once, refreshed in the background.
//
// Nothing else is touched: /api/, sockets, plugin and design files, shares,
// and every non-GET request go to the network as before.

const VERSION = "v2";
const PAGES = `grove-pages-${VERSION}`;
const ASSETS = `grove-assets-${VERSION}`;
const STATIC = `grove-static-${VERSION}`;
const KEEP = new Set([PAGES, ASSETS, STATIC]);

const NAV_TIMEOUT_MS = 3000;
// Hashed files from older builds pile up; keep the newest ones only.
const MAX_ASSETS = 800;

const STATIC_FILES = new Set([
  "/boot-theme.js",
  "/manifest.json",
  "/pcm-worklet.js",
  "/favicon.svg",
  "/favicon-light.svg",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/logo.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("grove-") && !KEEP.has(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(page(event, url));
  } else if (path.startsWith("/assets/")) {
    event.respondWith(asset(req));
  } else if (STATIC_FILES.has(path) || path.startsWith("/app-icons/") || path.startsWith("/agent-icon/")) {
    event.respondWith(staticFile(event, req));
  }
});

// Every in-app route is the same index.html; the other HTML entries
// (radio.html, tray.html, …) are kept under their own name.
function pageKey(url) {
  const p = url.pathname;
  return p.endsWith(".html") ? p : "/";
}

function storable(res) {
  return res && res.ok && res.type === "basic";
}

async function page(event, url) {
  const cache = await caches.open(PAGES);
  const key = pageKey(url);
  const network = fetch(event.request).then(async (res) => {
    if (storable(res) && (res.headers.get("content-type") || "").includes("text/html")) {
      await cache.put(key, res.clone());
    }
    return res;
  });
  // Let a slow answer still refresh the copy after we stopped waiting.
  event.waitUntil(network.catch(() => {}));

  const cached = await cache.match(key);
  if (!cached) return network;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    return first || cached;
  } catch {
    return cached;
  }
}

async function asset(req) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // A file the server no longer has comes back as index.html; never keep that.
  if (storable(res) && !(res.headers.get("content-type") || "").includes("text/html")) {
    await cache.put(req, res.clone());
    trim(cache);
  }
  return res;
}

async function staticFile(event, req) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(req);
  const network = fetch(req).then(async (res) => {
    if (storable(res)) await cache.put(req, res.clone());
    return res;
  });
  if (!cached) return network;
  event.waitUntil(network.catch(() => {}));
  return cached;
}

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ASSETS;
  for (let i = 0; i < extra; i += 1) await cache.delete(keys[i]);
}
