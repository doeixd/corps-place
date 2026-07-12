// Keep OPEN TABS as fresh as the edge. The publish pipeline purges Cloudflare
// the moment a new read-model goes live, but a tab that's already open still
// holds (a) router loader caches (staleTime 5 min) and (b) the service worker's
// stale-while-revalidate data cache. Instead of shortening those TTLs (which
// would cost every navigation), watch the read-model VERSION — the tiny
// /read-model/manifest.json (max-age=30, purged on publish) — and invalidate
// both caches precisely when it changes.
//
// Check cadence: on tab focus/visibility (the moment a parked tab matters) plus
// a 60s interval while visible. Hidden tabs don't poll.

interface InvalidatableRouter {
  invalidate: () => Promise<void> | void;
}

const CHECK_MS = 60_000;

export function watchReadModelFreshness(router: InvalidatableRouter): () => void {
  if (typeof window === 'undefined') return () => {};

  let lastVersion: string | null = null;
  let checking = false;

  const check = async () => {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const res = await fetch('/read-model/manifest.json');
      if (!res.ok) return;
      const meta = (await res.json()) as { version?: string };
      const v = meta.version ?? null;
      if (!v || v === 'dev') return; // degraded manifest — never treat as a change
      if (lastVersion === null) {
        lastVersion = v; // baseline: the version this tab loaded with
        return;
      }
      if (v === lastVersion) return;
      lastVersion = v;
      // New read-model published while this tab was open. Clear the SW's SWR
      // data cache FIRST (otherwise the re-run loaders would read the stale
      // cache right back), then re-run the active route's loaders.
      navigator.serviceWorker?.controller?.postMessage('INVALIDATE_DATA');
      // The SW deletes the cache asynchronously; give it a beat before refetching.
      await new Promise((r) => setTimeout(r, 250));
      await router.invalidate();
    } catch {
      /* offline/transient — try again next tick */
    } finally {
      checking = false;
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  const timer = setInterval(() => void check(), CHECK_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  void check(); // establish the baseline right away

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}
