// Offline cache for the app shell. Network first (so a new version shows at once), falling back to the cached copy
// if the network is slow (> 1.5 s) or down. Market data (WebSocket / exchange REST) is never cached.
const CACHE = 'orderflow-v3';
const FILES = ['./', 'index.html', 'app.js', 'engine.js', 'core.js', 'feeds.js', 'lzma.js', 'manifest.json', 'icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const slow = new Promise(res => setTimeout(res, 1500)).then(() => c.match(e.request, { ignoreSearch: true }));
    try { return (await Promise.race([net, slow])) || await net; }
    catch { return (await c.match(e.request, { ignoreSearch: true })) || Response.error(); }
  }));
});
