// A cheap, SSR-readable "might this visitor be signed in?" signal, used ONLY to
// decide whether to mount the auth-dependent chrome (ConsentGate). It is not an
// authorization check — the server-fns still verify the real session.
//
// better-auth namespaces its session cookie as `better-auth.session_token`
// (prefixed `__Secure-` over HTTPS in prod). auth.ts sets no custom
// `advanced.cookiePrefix`, so the substring below appears for any signed-in
// visitor in both dev (http) and prod (https, where the name is
// `__Secure-better-auth.session_token` — a superstring of the needle).
//
// Fail-safe by construction: a visitor with no such cookie is signed out, so
// this can only SKIP the (client-only, signed-out-renders-null) ConsentGate for
// cookieless visitors — it can never suppress the consent modal for a real
// session. If auth.ts ever sets `advanced.cookiePrefix`, update the needle.
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

const SESSION_COOKIE_NEEDLE = 'better-auth.session_token=';

/** True when a better-auth session cookie is present (an upper bound on "signed in"). */
export const maybeSignedIn = createIsomorphicFn()
  .server((): boolean => (getRequestHeader('cookie') ?? '').includes(SESSION_COOKIE_NEEDLE))
  .client((): boolean => document.cookie.includes(SESSION_COOKIE_NEEDLE));
