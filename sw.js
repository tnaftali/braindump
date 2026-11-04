// Offline cache, stale-while-revalidate: answer from cache, refresh it in the background.
// A deploy shows up on the second launch. Bump VERSION to drop the old cache outright.
const VERSION = "v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "logic.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => { // revalidate with the server, not the HTTP cache
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      if (!cached) return fresh;
      e.waitUntil(fresh.catch(() => {})); // offline: keep serving the cached copy
      return cached;
    }),
  );
});
