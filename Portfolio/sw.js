/* Kujira Portfolio service worker — offline shell + installable PWA.
   Network-first for the app HTML (fresh code when online, shell when offline).
   Cache-first for local static assets and Chart.js CDN.
   Apps Script (GAS) fetches are never intercepted — always live network.
   Bump CACHE_NAME to force all clients to discard their old shell on next load.
   RULE: bump it whenever kjr-core.js or any other cached static asset changes —
   index.html is network-first (self-healing) but the rest are cache-first and
   will be served stale forever otherwise. */

const CACHE_NAME = 'kjr-portfolio-v2.52';
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

const CORE_ASSETS = [
  './index.html',
  './Worker/theme-init.js',
  './Worker/app.js?v=2.52',
  './Worker/kjr-core.js?v=2.52',
  './Worker/kjr-sortable.js?v=2.52',
  './Worker/manifest.webmanifest',
  './Worker/whale-icon.png',
  CHART_JS_URL,
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      Promise.allSettled(CORE_ASSETS.map((u) => c.add(u)))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Apps Script GAS calls: never intercept, always hit the network.
  if (url.host.endsWith('script.google.com') || url.host.endsWith('googleusercontent.com')) return;

  // Chart.js CDN: cache-first (pre-cached on install for offline use).
  if (req.url === CHART_JS_URL) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE_NAME);
        c.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // All other cross-origin (future CDN additions, etc.): pass through.
  if (url.origin !== self.location.origin) return;

  // App HTML: network-first so updates land immediately; fall back to cache offline.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE_NAME);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) ||
          new Response('Offline — open the app while connected to cache it first.',
            { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Remaining same-origin assets (kjr-core.js, manifest, icon): cache-first.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE_NAME);
        c.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      // Not in cache and the network fetch failed: give a small explicit
      // body + Content-Type so this reads as a clear offline signal in
      // devtools/network tab, not a broken/empty asset.
      return cached || new Response('Offline, asset not cached and network unavailable.',
        { status: 504, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
