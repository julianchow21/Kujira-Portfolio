/* Offline app shell. Bump CACHE on every ship so clients pull the new build. */
const CACHE = 'kjr-forex-v0.15';
const CACHE_PREFIX = 'kjr-forex-';
const SHELL = ['./', './index.html', './welcome.html', './pricing.html', './terms.html', './privacy.html', './refunds.html', './icon.svg', './manifest.webmanifest', './config.js?v=1.0', './public-config.js?v=0.14', './lib/theme-init.js?v=1.0', './lib/kjr-format.js?v=1.2', './lib/kjr-calendar.js?v=1.0', './lib/supabase-2.117.2.umd.js?v=2.117.2', './lib/auth-client.js?v=1.0', './lib/public.js?v=0.14', './lib/public.css?v=0.14'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GETs. Never touch Supabase / API calls, they must
  // always hit the network so the user never sees stale cloud data.
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Network-first, fall back to cache (so a deploy is picked up immediately when online).
  // Navigations bypass the browser HTTP cache as well as this worker's cache,
  // while the cache fallback still keeps the app usable offline.
  const networkReq = req.mode === 'navigate' ? new Request(req, { cache: 'no-store' }) : req;
  e.respondWith(
    fetch(networkReq).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
