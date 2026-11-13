// Offline cache, stale-while-revalidate: answer from cache, refresh it in the background.
// A deploy shows up on the second launch. Bump VERSION to drop the old cache outright.
const VERSION = "v100";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "logic.js",
  "nl.js",
  "sync.js",
  "manifest.webmanifest",
  "icon.svg",
  "favicon.svg",
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

// Reminders: the Worker pushes { k: task id, b: title encrypted with the data key }. The page saved that key in IndexedDB.
const dataKey = () => new Promise((res) => {
  const r = indexedDB.open("braindump", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("k");
  r.onerror = () => res(null);
  r.onsuccess = () => { const q = r.result.transaction("k").objectStore("k").get("key"); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); };
});
const title = async (b) => {
  const raw = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  let key = await dataKey();
  if (!key) throw new Error("no key");
  if (!(key instanceof CryptoKey)) key = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]); // the page stores the raw bytes
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) }, key, raw.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt));
};
self.addEventListener("push", (e) => {
  e.waitUntil((async () => { // iOS needs a notification for every push, so fall back to a generic one
    let t = "A task is due", c = "", v = "", k = "";
    try { const m = e.data.json(); k = m.k; ({ t, c = "", v = "" } = await title(m.b)); } catch (err) { c = `Open Tasks to fix reminders (${err?.message ?? err})`; } // say why: a bare fallback hides a missing key
    await self.registration.showNotification(t, { body: c, tag: k, icon: "icon-192.png", data: { v } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const v = e.notification.data?.v;
  e.waitUntil(clients.matchAll({ type: "window" }).then(async (cs) => {
    if (!cs[0]) return clients.openWindow(v ? `./?view=${encodeURIComponent(v)}` : "./");
    await cs[0].focus();
    if (v) cs[0].postMessage({ view: v });
  }));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).hostname.endsWith(".workers.dev")) return; // sync API must never come from cache
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => { // revalidate with the server, not the HTTP cache
        if (res.ok || res.type === "opaque") cache.put(e.request, res.clone()); // opaque: the cross-origin font files
        return res;
      });
      if (!cached) return fresh;
      e.waitUntil(fresh.catch(() => {})); // offline: keep serving the cached copy
      return cached;
    }),
  );
});
