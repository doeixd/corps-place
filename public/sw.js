// Read-model offline service worker (READ_MODEL_PLAN §9, §0.1.4).
//
// Runtime caching (NOT a full precache): each response is cached as it's fetched,
// so "pages I saw" + intent-preloaded routes work offline. Conservative by design
// — it must never serve stale dynamic data while online or break SSR/server fns:
//   • navigations (HTML docs) → NetworkFirst (online = fresh SSR, offline = cache)
//   • hashed static assets     → CacheFirst (immutable, content-hashed names)
//   • /read-model/*.json       → StaleWhileRevalidate (offline payload)
//   • hybrid server fns (GET)  → StaleWhileRevalidate — these are pure read-model
//     reads (no auth/cookies; see the nitro routeRule that marks them public) and
//     are the loader data for the directory pages, so caching them makes those
//     pages work offline and repeat-render instantly
//   • /api/*, other server fns, POST → bypassed entirely (never intercepted/cached)
//
// Cache name carries a version; bump CACHE_VERSION (or rely on the activate step
// that drops caches not matching) to invalidate. The client registration keys
// updates on /read-model/meta.json built_at.

const CACHE_VERSION = 'rm-v3';
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
  // Read-model published: drop the SWR'd data cache (hybrid server-fns +
  // read-model JSON) so the next fetches hit the network and re-cache fresh
  // data. Hashed assets and NetworkFirst docs are already safe.
  if (event.data === 'INVALIDATE_DATA') {
    event.waitUntil ? event.waitUntil(caches.delete(DATA_CACHE)) : caches.delete(DATA_CACHE);
  }
});

const isAsset = (url) =>
  /\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|avif|gif|ico)$/i.test(url.pathname) ||
  url.pathname.startsWith('/assets/') ||
  url.pathname.startsWith('/_build/');

// manifest.json is the VERSION SIGNAL (freshness watcher + SW update check) —
// serving it stale-while-revalidate would delay change detection by a full
// poll tick, so it always goes to the network (browser cache max-age=30 +
// edge purge on publish keep it cheap and current).
const isData = (url) =>
  url.pathname.startsWith('/read-model/') && !url.pathname.endsWith('/manifest.json');

// The hybrid server-fns are the ONE cacheable server-fn family: pure read-model
// reads, same JSON for everyone until the next emit (mirrors the nitro routeRule
// that stamps them `public, max-age=300`). Everything else under /_serverFn stays
// bypassed (auth/fantasy/admin must always hit the network).
const isHybridFnData = (url) =>
  url.pathname.startsWith('/_serverFn/app_lib_server-fns_hybrid_ts--');

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
  url.pathname === '/app-icon.svg' ||
  url.pathname === '/favicon.svg' ||
  url.pathname === '/favicon.ico' ||
  url.pathname.startsWith('/_serverFn') ||
  url.pathname.includes('/_server') ||
  url.pathname.startsWith('/__');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (isBypassed(url) && !isHybridFnData(url)) return; // server fns / API — passthrough

  // Navigations: NetworkFirst so online always renders fresh SSR; cache the doc
  // for offline, and fall back to the cached doc (then any cached doc) offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(DOC_CACHE);
          await cache.put(request, fresh.clone());
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
  if (isData(url) || isHybridFnData(url)) {
    // Hybrid fn URLs carry ?payload= (never ?v=), so they always take the
    // StaleWhileRevalidate branch below — instant from cache, refreshed behind.
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

// --- Web Push (Fantasy DCI, §8.2) -------------------------------------------
// A push payload is JSON: { title, body, url? }. We show a notification and, on
// click, focus an existing tab on that URL or open a new one.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'Fantasy DCI';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/favicon.ico',
      data: { url: payload.url || '/fantasy' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/fantasy';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })()
  );
});
