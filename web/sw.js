/* EachDay Offline-First PWA Service Worker */
const CACHE_NAME = "eachday-pwa-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon.svg",
  "./js/app.js",
  "./js/i18n.js",
  "./js/images.js",
  "./js/pose.js",
  "./js/objects.js",
  "./js/aligner.js",
  "./js/color.js",
  "./js/renderer.js",
  "./js/exporter.js",
  "./js/audio.js",
  "./js/demo.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isModelOrCdn =
    url.pathname.endsWith(".onnx") ||
    url.pathname.endsWith(".wasm") ||
    url.hostname.includes("cdn.jsdelivr.net");

  if (isModelOrCdn) {
    // Cache-first for heavy ONNX models, WASM runtimes, and versioned CDN libraries
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Network-first with offline cache fallback for local app shell
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return resp;
      })
      .catch(() => caches.match(req))
  );
});
