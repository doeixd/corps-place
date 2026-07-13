// Background route warmer: after a page settles, quietly `preloadRoute` the
// likely-next detail pages so the first click into one is instant (its loader
// data is already in the router cache — the same path an on-hover intent preload
// would take, just proactive instead of waiting for the hover).
//
// Gentle by construction: runs only in the browser, only during idle time, only
// on a connection that isn't data-saver / 2g, pauses while the tab is hidden,
// and caps concurrency so it never competes with real navigation. Returns a
// cleanup that cancels any remaining warms (call it from a useEffect).

// How many directory rows to bulk-warm. The router preloads on hover/touch-intent
// (`defaultPreload: 'intent'`), so bulk-warming only needs to cover the cards
// visible before the user interacts. Detail warms cascade into several read-model
// shard fetches each, so a small cap is the difference between ~30 and ~340
// speculative requests on a directory page (mobile). See DATA_QUALITY_NOTES / perf.
export const WARM_ABOVE_FOLD = 6;

type WarmTarget = { to: string; params: Record<string, string> };

interface PreloadableRouter {
  preloadRoute: (opts: { to: string; params: Record<string, string> }) => Promise<unknown>;
}

const onIdle = (cb: () => void): void => {
  const ric = (
    globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 2000 });
  else setTimeout(cb, 200);
};

const connectionAllowsWarm = (): boolean => {
  const c = (
    navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  if (!c) return true;
  if (c.saveData) return false;
  if (typeof c.effectiveType === 'string' && /(^|-)2g$/.test(c.effectiveType)) return false;
  return true;
};

/**
 * Warm the NESTED detail route (+ optional hero image) for a directory card only
 * once it scrolls into view — the visible-only, filter-proof successor to bulk
 * `warmRoutesOnIdle(slice(0, N))`. Observes `[data-grid-key]` elements (emitted by
 * StaggeredGrid and score rows); when one intersects, it resolves that key to a
 * route/image and preloads it once. `rootMargin` warms a screenful ahead so the
 * card is ready by the time it's tapped; `startDelayMs` waits for the page to
 * settle first so warming never competes with the initial load.
 *
 * Re-run the effect when the rendered/filtered set changes so newly-shown cards
 * get observed (the query runs at attach time).
 *
 * Flood-proof by construction (a real HAR showed 272 requests in 4s — 30 corps
 * × 4 shards + merch — from one fast scroll through /corps, every request then
 * waiting 5-6s behind the rest):
 * - DWELL: a card must stay intersecting `dwellMs` before it's queued; cards
 *   flicked past during a fast scroll warm nothing.
 * - BOUNDED QUEUE: at most `concurrency` preloads in flight; each detail warm
 *   cascades into several read-model shard fetches, so 2 in flight ≈ ~10
 *   concurrent requests worst case — never enough to starve a real navigation.
 */
export function warmVisibleOnIdle(
  router: PreloadableRouter,
  resolve: (key: string) => (WarmTarget & { image?: string }) | null,
  {
    rootMargin = '600px 0px',
    startDelayMs = 1200,
    selector = '[data-grid-key]',
    dwellMs = 400,
    concurrency = 2,
  }: {
    rootMargin?: string;
    startDelayMs?: number;
    selector?: string;
    dwellMs?: number;
    concurrency?: number;
  } = {}
): () => void {
  if (
    typeof window === 'undefined' ||
    !connectionAllowsWarm() ||
    typeof IntersectionObserver === 'undefined'
  ) {
    return () => {};
  }
  let cancelled = false;
  let io: IntersectionObserver | null = null;
  const warmed = new Set<string>();
  const dwellTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let inFlight = 0;

  const pump = (): void => {
    if (cancelled) return;
    if (document.visibilityState === 'hidden') {
      onIdle(pump);
      return;
    }
    while (inFlight < concurrency && queue.length) {
      const key = queue.shift()!;
      const r = resolve(key);
      if (!r) continue;
      inFlight++;
      Promise.resolve(router.preloadRoute({ to: r.to, params: r.params }))
        .catch(() => {})
        .finally(() => {
          inFlight--;
          onIdle(pump);
        });
      if (r.image) {
        const img = new Image();
        img.decoding = 'async';
        img.src = r.image;
      }
    }
  };

  const timer = setTimeout(() => {
    onIdle(() => {
      if (cancelled) return;
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target;
            if (!entry.isIntersecting) {
              // Left the viewport before the dwell elapsed — a flick-scroll pass.
              const t = dwellTimers.get(el);
              if (t) {
                clearTimeout(t);
                dwellTimers.delete(el);
              }
              continue;
            }
            if (dwellTimers.has(el)) continue;
            dwellTimers.set(
              el,
              setTimeout(() => {
                dwellTimers.delete(el);
                if (cancelled) return;
                io?.unobserve(el);
                const key = (el as HTMLElement).dataset.gridKey;
                if (!key || warmed.has(key)) return;
                warmed.add(key);
                queue.push(key);
                pump();
              }, dwellMs)
            );
          }
        },
        { rootMargin }
      );
      document.querySelectorAll(selector).forEach((el) => io!.observe(el));
    });
  }, startDelayMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    for (const t of dwellTimers.values()) clearTimeout(t);
    dwellTimers.clear();
    io?.disconnect();
  };
}

export function warmRoutesOnIdle(
  router: PreloadableRouter,
  targets: readonly WarmTarget[],
  { concurrency = 2 }: { concurrency?: number } = {}
): () => void {
  if (typeof window === 'undefined' || targets.length === 0 || !connectionAllowsWarm()) {
    return () => {};
  }
  let cancelled = false;
  let i = 0;
  const next = (): void => {
    if (cancelled || i >= targets.length) return;
    // Pause (don't drop) while the tab is backgrounded.
    if (document.visibilityState === 'hidden') {
      onIdle(next);
      return;
    }
    const t = targets[i++]!;
    Promise.resolve(router.preloadRoute({ to: t.to, params: t.params }))
      .catch(() => {})
      .finally(() => onIdle(next));
  };
  onIdle(() => {
    for (let w = 0; w < concurrency; w++) onIdle(next);
  });
  return () => {
    cancelled = true;
  };
}

/**
 * Background-preload a list of image URLs into the browser cache (idle +
 * connection-gated, same discipline as warmRoutesOnIdle). Pass the *exact* URL
 * the page will request (e.g. the proxiedImage variant) so the later render is a
 * cache hit. Returns a cleanup that cancels remaining loads.
 */
export function warmImagesOnIdle(
  urls: readonly string[],
  { concurrency = 3 }: { concurrency?: number } = {}
): () => void {
  if (typeof window === 'undefined' || urls.length === 0 || !connectionAllowsWarm()) {
    return () => {};
  }
  let cancelled = false;
  let i = 0;
  const next = (): void => {
    if (cancelled || i >= urls.length) return;
    if (document.visibilityState === 'hidden') {
      onIdle(next);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => onIdle(next);
    img.onerror = () => onIdle(next);
    img.src = urls[i++]!;
  };
  onIdle(() => {
    for (let w = 0; w < concurrency; w++) onIdle(next);
  });
  return () => {
    cancelled = true;
  };
}
