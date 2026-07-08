// Background route warmer: after a page settles, quietly `preloadRoute` the
// likely-next detail pages so the first click into one is instant (its loader
// data is already in the router cache — the same path an on-hover intent preload
// would take, just proactive instead of waiting for the hover).
//
// Gentle by construction: runs only in the browser, only during idle time, only
// on a connection that isn't data-saver / 2g, pauses while the tab is hidden,
// and caps concurrency so it never competes with real navigation. Returns a
// cleanup that cancels any remaining warms (call it from a useEffect).

type WarmTarget = { to: string; params: Record<string, string> };

interface PreloadableRouter {
  preloadRoute: (opts: { to: string; params: Record<string, string> }) => Promise<unknown>;
}

const onIdle = (cb: () => void): void => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 2000 });
  else setTimeout(cb, 200);
};

const connectionAllowsWarm = (): boolean => {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  if (!c) return true;
  if (c.saveData) return false;
  if (typeof c.effectiveType === 'string' && /(^|-)2g$/.test(c.effectiveType)) return false;
  return true;
};

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
