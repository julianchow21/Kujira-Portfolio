/* Offline app shell. Bump CACHE on every ship so clients pull the new build. */
const CACHE = 'kjr-forex-v0.15';
const CACHE_PREFIX = 'kjr-forex-';
const SHELL = ['./', './index.html', './welcome.html', './pricing.html', './terms.html', './privacy.html', './refunds.html', './icon.svg', './manifest.webmanifest', './config.js?v=1.0', './public-config.js?v=0.14', './lib/theme-init.js?v=1.0', './lib/kjr-format.js?v=1.2', './lib/kjr-calendar.js?v=1.0', './lib/supabase-2.117.2.umd.js?v=2.117.2', './lib/auth-client.js?v=1.0', './lib/public.js?v=0.14', './lib/public.css?v=0.14'];
// Shared files outside Forex/, stored on first use only (best effort), so a missing file can never fail the install above.
const SHARED = ['../Portfolio/Worker/whale-icon.png'];

// Only these exact URLs (path and query) are ever stored. A cache-busted visit such as index.html?v=123 is fetched and shown but
// not kept, so the cache stays at the shell entries instead of growing by one entry per query string.
let storable = null;
function isStorable(url) {
  if (!storable) storable = new Set(SHELL.concat(SHARED).map(p => new URL(p, self.location.href).href));
  const u = new URL(url);
  u.hash = '';
  return storable.has(u.href);
}

// Offline answer. A navigation falls back to the stored page with the same path (a cache-busted or hashed visit of a shell page),
// then to the app shell. Anything else that is not stored is a plain network error, never HTML standing in for a script.
async function fromCache(req, navigating) {
  const exact = await caches.match(req);
  if (exact) return exact;
  if (navigating) return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html')) || Response.error();
  return Response.error();
}

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
  const navigating = req.mode === 'navigate';
  const networkReq = navigating ? new Request(req, { cache: 'no-store' }) : req;
  e.respondWith(
    fetch(networkReq).then(res => {
      if (res.ok && isStorable(req.url)) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => fromCache(req, navigating))
  );
});
