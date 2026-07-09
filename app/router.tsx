import { createRouter as createTanStackRouter, stringifySearchWith } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { NotFound } from './components/not-found';
import { RouteErrorFallback } from './components/error-fallback';

export function getRouter() {
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
    // 5 min, matching defaultStaleTime's spirit and the routes' own staleTimes
    // (5min–Infinity): at the old 30s, an intent/visible preload expired before a
    // slower click and the navigation refetched from origin anyway — the data is
    // read-model output that changes only on re-emit, so minutes-stale is fine.
    defaultPreloadStaleTime: 300_000,
    // Page data is now served from the precomputed read-model (READ_MODEL_PLAN
    // §8) and only changes when ingest re-emits, so loader results can be reused
    // across navigations rather than refetched every time. Conservative global
    // default; the 2026 refresh action calls router.invalidate() to bust it, and
    // per-season tuning (current 1d / historical Infinity) can come with the SW
    // (Phase 5) + Fate live-updates (Phase 6).
    defaultStaleTime: 60_000,
    defaultNotFoundComponent: NotFound,
    // Branded, recoverable screen for any uncaught route render/loader error
    // instead of TanStack's raw error dump (a single component crash used to
    // blank the whole page).
    defaultErrorComponent: RouteErrorFallback,
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
    router: ReturnType<typeof getRouter>;
  }
}

// Back-compat alias (pre-1.132 Start expected createRouter).
export const createRouter = getRouter;
