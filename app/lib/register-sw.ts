// Service-worker registration for the offline read-model (READ_MODEL_PLAN §9).
//
// OFF BY DEFAULT. A service worker changes caching semantics site-wide and is
// sticky in browsers, so it only registers when VITE_ENABLE_SW === 'true' AND
// in a production build. When disabled it actively *unregisters* any previously
// installed worker and clears its caches — a kill switch so a bad/stale SW can
// be turned off by shipping with the flag unset.
//
// Update strategy: poll /read-model/meta.json; when built_at changes, tell the
// waiting worker to skipWaiting so clients pick up the new version (the SW's
// StaleWhileRevalidate already refreshes the JSON itself).

const ENABLED = import.meta.env.PROD && import.meta.env.VITE_ENABLE_SW === 'true';

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  if (!ENABLED) {
    // Kill switch: remove any worker left from a previous (enabled) deploy.
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    if ('caches' in window) {
      void caches.keys().then((keys) => {
        for (const k of keys) if (k.startsWith('rm-')) void caches.delete(k);
      });
    }
    return;
  }

  // `registerServiceWorker` is called from a post-hydration effect, by which
  // point `window.load` has usually already fired — a bare `load` listener would
  // then never run and the worker would never register (breaking push alerts).
  // Register now if the document is already loaded; otherwise wait for `load`.
  const start = () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // When an updated worker is waiting, activate it immediately.
        const promote = () => reg.waiting?.postMessage('SKIP_WAITING');
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) promote();
          });
        });
        // Re-check for a new read-model version periodically (cheap HEAD-ish GET).
        let lastBuiltAt: string | null = null;
        const checkVersion = async () => {
          try {
            const res = await fetch('/read-model/meta.json', { cache: 'no-store' });
            if (!res.ok) return;
            const meta = await res.json();
            if (lastBuiltAt && meta.built_at !== lastBuiltAt) void reg.update();
            lastBuiltAt = meta.built_at ?? lastBuiltAt;
          } catch {
            /* offline or missing snapshot — ignore */
          }
        };
        void checkVersion();
        setInterval(checkVersion, 5 * 60 * 1000);
      })
      .catch(() => {
        /* registration failed — app still works without offline support */
      });
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
