import { createRouter as createTanStackRouter, stringifySearchWith } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { NotFound } from './components/not-found';

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    // Built-in scroll restoration: resets to top on forward navigation and restores
    // the prior position on back/forward. In-place search-param updates (prediction
    // roll / likelihood window / filters) pass `resetScroll: false` via useSearchSync
    // so they don't scroll the page.
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Reuse preloaded loader data on the real navigation instead of treating it
    // as immediately stale (0 = always refetch on click, defeating the preload).
    defaultPreloadStaleTime: 30_000,
    // Page data is now served from the precomputed read-model (READ_MODEL_PLAN
    // §8) and only changes when ingest re-emits, so loader results can be reused
    // across navigations rather than refetched every time. Conservative global
    // default; the 2026 refresh action calls router.invalidate() to bust it, and
    // per-season tuning (current 1d / historical Infinity) can come with the SW
    // (Phase 5) + Fate live-updates (Phase 6).
    defaultStaleTime: 60_000,
    defaultNotFoundComponent: NotFound,
    // Don't JSON-quote plain string params (the default wraps JSON-parseable
    // strings like "2026" in quotes). Omitting the parser arg keeps strings raw,
    // so URLs read `?season=2026` instead of `?season="2026"`. Numeric/boolean-
    // looking values are decoded back as number/boolean, so route `validateSearch`
    // functions coerce them as needed.
    stringifySearch: stringifySearchWith(JSON.stringify),
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
