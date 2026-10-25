/* Only cache PUBLIC app-shell files. Never cache private list data. */
const CACHE = "slumpval-shell-v4";
const SHELL = ["./", "./index.html", "./style.css", "./pattern.js", "./app.js", "./manifest.webmanifest", "./icon.svg", "./apple-touch-icon.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("slumpval-shell-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  const path = url.pathname;
  const scopePath = new URL("./", self.registration.scope).pathname;
  if (!path.startsWith(scopePath)) return;
  const relative = path.slice(scopePath.length);
  if (!["", "index.html", "style.css", "pattern.js", "app.js", "manifest.webmanifest", "icon.svg", "apple-touch-icon.png"].includes(relative)) return;
  // Prefer the current public app code online, but preserve offline support.
  // IndexedDB vault data is never requested over the network or cached here.
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (_) {
      return (await caches.match(event.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});