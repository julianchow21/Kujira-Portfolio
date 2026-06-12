/* Kill-switch service worker. The Kujira Portfolio app moved from the repo
   root into Portfolio/, so the old root-scoped worker must go: it would keep
   controlling pages under this scope (including Portfolio/) and serve stale
   cached assets. Existing clients fetch this file on their next update check,
   it activates, wipes the old kjr-portfolio-* caches, and unregisters itself.
   New installs never see it: the app now registers Portfolio/sw.js. */

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kjr-portfolio')).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
