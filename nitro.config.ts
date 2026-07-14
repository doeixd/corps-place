// Nitro server config (TanStack Start builds on Nitro — preset node-server). Auto-
// loaded from the project root and merged with the framework's own config.
//
// Why this file exists: Nitro serves the Vite build output under /assets/* with only
// ETag/Last-Modified — no Cache-Control — so browsers revalidate every JS/CSS chunk on
// every navigation and every repeat visit (a network round-trip each, even when it's a
// 304). Those filenames are content-hashed, so the bytes never change for a given URL;
// cache them immutably for a year. This is the single biggest client-perf win without a
// CDN. (HTML/document responses are unaffected — they don't match /assets/**.)
export default {
  // Guard: error responses (e.g. rollout-window 404s for new chunk names) must
  // never carry the immutable header below — Cloudflare cached such a 404 for up
  // to a year per colo/encoding variant (2026-07-02 incident).
  plugins: [
    './server-plugins/no-cache-errors.ts',
    './server-plugins/serverfn-cache.ts',
    './server-plugins/slow-request.ts',
    './server-plugins/early-hints.ts',
  ],
  routeRules: {
    '/assets/**': {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    },
    // Read-model shards are content-addressed by a `?v=` token (a new emit = a new
    // URL), so the bytes for a given URL never change — cache them immutably for a
    // year. Without this, prod (`node .output/server`, not `proxy.mjs`) serves them
    // with no Cache-Control, so every client navigation re-fetches every detail
    // shard over the network instead of reading the browser cache. The manifest is
    // the one revalidated entry point (it changes each emit), so keep it short.
    '/read-model/manifest.json': {
      headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=86400' },
    },
    '/read-model/**': {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    },
    // The hybrid server-fns are pure read-model reads (no auth, no cookies, no
    // per-user data) — the same deterministic JSON for everyone until the next
    // emit. Without a Cache-Control they refetch from origin on every navigation
    // in every session (measured ~900ms on throttled mobile vs ~50ms from cache).
    // Browser: 5 min (matches the routes' staleTime). Edge: 1 h — with only
    // max-age=300 the long-tail per-corps URLs were near-permanent MISSes at any
    // given PoP (a cold getCorpsSeasonSnapshots measured 1.25s in a real HAR);
    // every read-model publish purge_everything's the zone, so edge staleness is
    // bounded by the rare failed purge (≤1 h), not by TTL. SWR covers the expiry
    // gap without blocking. Errors are stripped to no-store by the
    // no-cache-errors plugin (prefix is in GUARDED_PREFIXES). NOTE: Cloudflare
    // only honors this at the edge with a Cache Rule for these paths ("respect
    // origin") — extensionless URLs aren't edge-cached by default; browser
    // caching works regardless.
    '/_serverFn/app_lib_server-fns_hybrid_ts--**': {
      headers: {
        'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=1800',
      },
    },
  },
};
