// Nitro plugin: make pure read-model server functions edge-cacheable.
//
// The nitro routeRule `/_serverFn/app_lib_server-fns_hybrid_ts--**`
// (nitro.config.ts) NEVER matches: radix3 only treats `**` as a whole path
// segment, so a partial-segment pattern is read as a literal. Result — the
// hybrid serverFn responses shipped with NO Cache-Control and Cloudflare marked
// them DYNAMIC, so every data fetch on every navigation hit origin. A router
// rule can't express "only these serverFns" (the fn id is one path segment), so
// we do the method + prefix check here, where the full path string is available.
//
// The hybrid GET fns are pure read-model reads — verified none read
// cookies/session — so their 2xx responses get a cacheable header. Errors are
// separately forced to no-store by no-cache-errors.ts (status >= 400 branch, so
// the two plugins never fight). GET only: the POST hybrid fns mutate/compute and
// CF won't edge-cache POST anyway.
type NitroAppLike = { hooks: { hook: (name: string, fn: (...args: any[]) => void) => void } };

const HYBRID_PREFIX = '/_serverFn/app_lib_server-fns_hybrid_ts--';
// getAnnouncement fires on EVERY page load (root banner) and reads the mutable
// admin_settings table — short TTL so the banner still updates within minutes.
const ANNOUNCEMENT_PREFIX = '/_serverFn/app_lib_server-fns_admin_ts--getAnnouncement_';

// Browser 5 min, edge 1 h, SWR covers expiry. A read-model publish purges the
// zone, so edge staleness is bounded by the publish cadence, not the TTL.
const LONG = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=1800';
const SHORT = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400';

const cacheableFor = (path: string): string | null => {
  if (path.startsWith(HYBRID_PREFIX)) return LONG;
  if (path.startsWith(ANNOUNCEMENT_PREFIX)) return SHORT;
  return null;
};

export default ((nitroApp: NitroAppLike) => {
  nitroApp.hooks.hook('request', (event: any) => {
    const path: string | undefined = event?.path;
    if (!path) return;
    const cc = cacheableFor(path);
    if (!cc) return;
    const method = (event?.method || event?.node?.req?.method || '').toUpperCase();
    if (method !== 'GET') return;
    const res = event?.node?.res;
    if (!res || typeof res.writeHead !== 'function') return;
    const original = res.writeHead.bind(res);
    res.writeHead = (...args: any[]) => {
      const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
      // Only successful reads; don't stomp a header a handler set deliberately.
      if (status < 400 && !res.getHeader('cache-control')) {
        res.setHeader('cache-control', cc);
      }
      return original(...args);
    };
  });
}) satisfies (nitroApp: NitroAppLike) => void;
