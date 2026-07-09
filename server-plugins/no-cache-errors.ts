// Nitro plugin: never let error responses inherit the immutable Cache-Control.
//
// INCIDENT (2026-07-02): the `/assets/**` routeRule stamps
// `public, max-age=31536000, immutable` on EVERY response for the path —
// including the 404s served during a zero-downtime rollout window (old container
// asked for new-build chunks). Cloudflare honored the header and cached those
// 404s per colo × encoding variant for up to a year, breaking the site for
// browsers hitting the poisoned variants until a manual purge.
//
// Implementation note: `beforeResponse` fires after the SSR stream has already
// flushed headers, and this renderer never emits `render:response` — so the only
// reliable interception point is the header flush itself. On the `request` hook
// (fires before any handler) we wrap `res.writeHead` for guarded paths; at flush
// time the final status is known, and any non-OK response gets
// `Cache-Control: no-store` regardless of what the routeRules middleware set.
// Plain function (not defineNitroPlugin — that helper isn't auto-imported for
// out-of-tree plugin paths in this build; a nitro plugin is just this signature).
type NitroAppLike = {
  hooks: { hook: (name: string, fn: (...args: any[]) => void) => void };
};

const GUARDED_PREFIXES = ['/assets/', '/read-model/', '/_serverFn/app_lib_server-fns_hybrid_ts--'];
const guarded = (path: string | undefined) =>
  Boolean(path && GUARDED_PREFIXES.some((p) => path.startsWith(p)));

export default ((nitroApp: NitroAppLike) => {
  nitroApp.hooks.hook('request', (event: any) => {
    if (!guarded(event?.path)) return;
    const res = event?.node?.res;
    if (!res || typeof res.writeHead !== 'function') return;
    const original = res.writeHead.bind(res);
    res.writeHead = (...args: any[]) => {
      const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (status >= 400) {
        res.setHeader('cache-control', 'no-store');
        // Headers passed positionally to writeHead override setHeader — scrub them.
        for (const a of args) {
          if (a && typeof a === 'object' && !Array.isArray(a)) {
            for (const k of Object.keys(a)) {
              if (k.toLowerCase() === 'cache-control') a[k] = 'no-store';
            }
          }
        }
      }
      return original(...args);
    };
  });
}) satisfies (nitroApp: NitroAppLike) => void;
