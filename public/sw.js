const CACHE_NAME = 'omnisight-static-assets-3.0.0';
const CACHEABLE_EXT = /\.(svg|png|webp|jpg|jpeg|ico|webmanifest)$/i;
const CACHEABLE_ROUTES = new Set([
  '/manifest.webmanifest',
]);
const CACHEABLE_DOCUMENT_ROUTES = new Set([
  '/',
  '/about',
  '/agents',
  '/docs',
  '/event-center',
  '/profile',
  '/settings',
  '/topology',
]);

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function normalizedCacheRequest(request) {
  const url = new URL(request.url);
  url.hash = '';
  if (request.destination === 'document' || !CACHEABLE_EXT.test(url.pathname)) {
    url.search = '';
  }
  return new Request(url.toString(), { credentials: 'same-origin' });
}

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (!sameOrigin(url)) return false;
  if (url.pathname === '/sw.js') return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/agent/')) return false;
  if (isDocumentRequest(request)) return CACHEABLE_DOCUMENT_ROUTES.has(url.pathname);
  if (CACHEABLE_ROUTES.has(url.pathname)) return true;
  return CACHEABLE_EXT.test(url.pathname);
}

function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  if (response.type && !['basic', 'default'].includes(response.type)) return false;
  const cc = response.headers.get('cache-control') || '';
  if (/\bno-store\b|\bno-cache\b/i.test(cc)) return false;
  const ct = response.headers.get('content-type') || '';
  return /text\/html|image\/|manifest\+json/i.test(ct);
}

function isDocumentRequest(request) {
  const accept = request.headers.get('accept') || '';
  return request.mode === 'navigate' || request.destination === 'document' || accept.includes('text/html');
}

function bypassesCache(request) {
  const cc = request.headers.get('cache-control') || '';
  return request.cache === 'reload' || cc.includes('no-cache') || cc.includes('no-store');
}

async function fetchAndCache(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheReq = normalizedCacheRequest(request);
  const response = await fetch(request);
  if (isCacheableResponse(response)) cache.put(cacheReq, response.clone()).catch(() => undefined);
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheReq = normalizedCacheRequest(request);
  try {
    return await fetchAndCache(request);
  } catch (err) {
    const cached = await cache.match(cacheReq);
    return cached || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheReq = normalizedCacheRequest(request);
  const cached = await cache.match(cacheReq);
  const network = fetch(request)
    .then(response => {
      if (isCacheableResponse(response)) cache.put(cacheReq, response.clone()).catch(() => undefined);
      return response;
    })
    .catch(() => null);

  if (cached) {
    network.catch(() => undefined);
    return cached;
  }

  const response = await network;
  return response || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (!isCacheableRequest(event.request)) return;
  if (isDocumentRequest(event.request)) {
    event.respondWith(bypassesCache(event.request) ? networkFirst(event.request) : staleWhileRevalidate(event.request));
    return;
  }
  if (bypassesCache(event.request)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(staleWhileRevalidate(event.request));
});
