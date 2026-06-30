// OmniSight previously cached full HTML shells through the service worker.
// That made old releases survive deployments and could leave the app stuck on
// stale "Loading..." screens. Keep the worker as an update/cleanup shim only.
const CACHE_PREFIXES = ['omnisight-', 'omnisight_static', 'omnisight-static'];

function shouldDeleteCache(name) {
  return CACHE_PREFIXES.some(prefix => String(name || '').startsWith(prefix));
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(shouldDeleteCache).map(key => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(client => {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) return client.navigate(client.url);
      } catch {}
      return null;
    }));
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agent/') || req.mode === 'navigate') {
    event.respondWith(fetch(new Request(req, { cache: 'no-store' })));
  }
});
