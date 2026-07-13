// Nitro plugin: log the origin of slow requests. Stores a start timestamp on
// event.context at request start; on 'afterResponse', anything that took more
// than 2s gets one console.warn line with method, path and whether a session
// cookie was present (an upper bound on "signed in" — same needle as
// app/lib/auth-cookie.ts; better-auth sets no custom cookiePrefix, and the
// prod `__Secure-` name is a superstring of the needle).
//
// Plain function (not defineNitroPlugin — that helper isn't auto-imported for
// out-of-tree plugin paths in this build; a nitro plugin is just this signature).
type NitroAppLike = {
  hooks: { hook: (name: string, fn: (...args: any[]) => void) => void };
};

const SLOW_MS = 2000;
const SESSION_COOKIE_NEEDLE = 'better-auth.session_token=';
// Noise we never care about: analytics beacon + static assets.
const SKIP_PREFIXES = ['/api/collect', '/assets/', '/geo/', '/favicon'];
const skipped = (path: string) => SKIP_PREFIXES.some((p) => path.startsWith(p));

export default ((nitroApp: NitroAppLike) => {
  nitroApp.hooks.hook('request', (event: any) => {
    if (event?.context) event.context._slowReqStart = Date.now();
  });
  nitroApp.hooks.hook('afterResponse', (event: any) => {
    const start = event?.context?._slowReqStart as number | undefined;
    if (typeof start !== 'number') return;
    const path: string = event?.path ?? event?.node?.req?.url ?? '';
    if (skipped(path)) return;
    const ms = Date.now() - start;
    if (ms <= SLOW_MS) return;
    const method: string = event?.node?.req?.method ?? 'GET';
    const cookie: string = event?.node?.req?.headers?.cookie ?? '';
    const signedIn = cookie.includes(SESSION_COOKIE_NEEDLE);
    console.warn(`[slow-request] ${ms}ms ${method} ${path} signedIn=${signedIn}`);
  });
}) satisfies (nitroApp: NitroAppLike) => void;
