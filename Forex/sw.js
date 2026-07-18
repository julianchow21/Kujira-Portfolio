/* Offline app shell. Bump CACHE on every ship so clients pull the new build. */
const CACHE = 'kjr-forex-v2';
const SHELL = ['./', './index.html', './icon.svg', './manifest.webmanifest', './lib/theme-init.js?v=1.0', './lib/kjr-format.js?v=1.1', './lib/kjr-calendar.js?v=1.0'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GETs. Never touch Supabase / API calls, they must
  // always hit the network so the user never sees stale cloud data.
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Network-first, fall back to cache (so a deploy is picked up immediately when online).
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
