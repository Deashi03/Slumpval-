/* Only cache PUBLIC app-shell files. Never cache private list data. */
const CACHE = "slumpval-shell-v1";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon.svg"];
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
  if (!["", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg"].includes(relative)) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)));
});