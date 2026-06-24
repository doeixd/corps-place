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
  routeRules: {
    '/assets/**': {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    },
  },
};
