/* PataHome service worker — makes the site installable and quick on slow
   connections without ever serving stale listings:
   - pages (HTML): network first, cached copy only when offline
   - CSS/JS/icons: served from cache, refreshed in the background
   - /api/*: never cached (always live data)
   Bump VERSION to drop old caches after big changes. */
const VERSION = "ph-v2";
const SHELL = ["/", "/browse", "/messages", "/offline.html", "/favicon.svg", "/favicon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // Cloudinary, maps, Google: let the browser handle
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  const isPage = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isPage) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match("/offline.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
