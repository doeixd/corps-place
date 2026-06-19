// Read-model offline service worker (READ_MODEL_PLAN §9, §0.1.4).
//
// Runtime caching (NOT a full precache): each response is cached as it's fetched,
// so "pages I saw" + intent-preloaded routes work offline. Conservative by design
// — it must never serve stale dynamic data while online or break SSR/server fns:
//   • navigations (HTML docs) → NetworkFirst (online = fresh SSR, offline = cache)
//   • hashed static assets     → CacheFirst (immutable, content-hashed names)
//   • /read-model/*.json       → StaleWhileRevalidate (offline payload)
//   • /api/*, server fns, POST → bypassed entirely (never intercepted/cached)
//
// Cache name carries a version; bump CACHE_VERSION (or rely on the activate step
// that drops caches not matching) to invalidate. The client registration keys
// updates on /read-model/manifest.json built_at.

const CACHE_VERSION = 'rm-v2';
const DOC_CACHE = `${CACHE_VERSION}-docs`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const ALL_CACHES = [DOC_CACHE, ASSET_CACHE, DATA_CACHE];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !ALL_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Allow the page to force an immediate update (used by the registration script
// when a new read-model version is detected).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isAsset = (url) =>
  /\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|avif|gif|ico)$/i.test(url.pathname) ||
  url.pathname.startsWith('/assets/') ||
  url.pathname.startsWith('/_build/');

const isData = (url) => url.pathname.startsWith('/read-model/');

// Drop cached entries for the same shard path that carry a different ?v= (i.e.
// superseded by a newer emit), keeping DATA_CACHE to one entry per shard.
const pruneSupersededShards = async (cache, currentUrl) => {
  const keys = await cache.keys();
  await Promise.all(
    keys.map((req) => {
      const u = new URL(req.url);
      return u.pathname === currentUrl.pathname && u.search !== currentUrl.search
        ? cache.delete(req)
        : undefined;
    })
  );
};

// Never touch these — dynamic, must always hit the network.
const isBypassed = (url) =>
  url.pathname.startsWith('/api/') ||
  url.pathname.startsWith('/_serverFn') ||
  url.pathname.includes('/_server') ||
  url.pathname.startsWith('/__');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (isBypassed(url)) return; // server fns / API — passthrough

  // Navigations: NetworkFirst so online always renders fresh SSR; cache only
  // successful docs for offline, and fall back to cached docs offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(DOC_CACHE);
            await cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cache = await caches.open(DOC_CACHE);
          return (await cache.match(request)) || (await cache.match('/')) || Response.error();
        }
      })()
    );
    return;
  }

  // Hashed static assets: CacheFirst (immutable).
  if (isAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const fresh = await fetch(request);
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      })()
    );
    return;
  }

  // Read-model JSON. Versioned shards (carry ?v=) are immutable — a new emit is a
  // new URL — so CacheFirst: serve from cache, never revalidate. The unversioned
  // entry points (manifest.json/meta.json) are how a new version is discovered, so
  // they stay StaleWhileRevalidate. (Pairs with the proxy.mjs cache policy.)
  if (isData(url)) {
    const immutable = url.searchParams.has('v');
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        const hit = await cache.match(request);
        if (immutable && hit) return hit;
        const fetching = fetch(request)
          .then(async (fresh) => {
            if (fresh.ok) {
              await cache.put(request, fresh.clone());
              // A new version of an immutable shard supersedes the old one — drop
              // stale entries for the same path (different ?v) so DATA_CACHE
              // doesn't grow unbounded across emits. Only runs on a real cache
              // miss (a version change), so it's cheap.
              if (immutable) await pruneSupersededShards(cache, url);
            }
            return fresh;
          })
          .catch(() => hit || Response.error());
        return hit || fetching;
      })()
    );
    return;
  }
  // Everything else: passthrough (no respondWith).
});
