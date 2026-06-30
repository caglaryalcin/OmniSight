// OmniSight no longer uses a service worker for app-shell/data caching.
// Older releases cached full HTML shells and API responses, which could make a
// deployed image keep serving stale "Loading..." screens. This worker exists
// only to clean up those old caches and unregister itself.
function shouldDeleteCache(name) {
  return true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(shouldDeleteCache).map(key => caches.delete(key)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(shouldDeleteCache).map(key => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await self.registration.unregister();
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
  // Intentionally do not intercept requests.
});
