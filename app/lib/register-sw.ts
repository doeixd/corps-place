// Service-worker registration for the offline read-model (READ_MODEL_PLAN §9).
//
// OFF BY DEFAULT. A service worker changes caching semantics site-wide and is
// sticky in browsers, so it only registers when VITE_ENABLE_SW === 'true' AND
// in a production build. When disabled it actively *unregisters* any previously
// installed worker and clears its caches — a kill switch so a bad/stale SW can
// be turned off by shipping with the flag unset.
//
// Update strategy: poll /read-model/manifest.json; when built_at changes, tell the
// waiting worker to skipWaiting so clients pick up the new version (the SW's
// StaleWhileRevalidate already refreshes the JSON itself).

const ENABLED = import.meta.env.PROD && import.meta.env.VITE_ENABLE_SW === 'true';
const READ_MODEL_MANIFEST_URL = '/read-model/manifest.json';

function getBuiltAt(value: unknown): string | null {
  if (value && typeof value === 'object' && 'built_at' in value) {
    const builtAt = value.built_at;
    return typeof builtAt === 'string' && builtAt.length > 0 ? builtAt : null;
  }
  return null;
}

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

  window.addEventListener('load', () => {
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
        // Re-check for a new read-model version periodically (cheap GET).
        let lastBuiltAt: string | null = null;
        const checkVersion = async () => {
          try {
            const res = await fetch(READ_MODEL_MANIFEST_URL, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            if (!res.ok) return;
            const builtAt = getBuiltAt(await res.json());
            if (!builtAt) return;
            if (lastBuiltAt && builtAt !== lastBuiltAt) void reg.update();
            lastBuiltAt = builtAt;
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
  });
}
