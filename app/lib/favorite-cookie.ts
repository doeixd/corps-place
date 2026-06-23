// The favorite corps is persisted in a cookie (not localStorage) so the server
// can read it during SSR and render the correct accent/favicon/theme-color into
// the initial HTML — eliminating both the first-paint flash and the hydration
// mismatch that previously reset branding on refresh.
import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

export const FAVORITE_COOKIE = 'cp_fav';
const MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/** Read the raw favorite cookie value (still JSON-encoded), on server or client. */
export const readFavoriteCookie = createIsomorphicFn()
  .server((): string | null => getCookie(FAVORITE_COOKIE) ?? null)
  .client((): string | null => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + FAVORITE_COOKIE + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  });

/** Write (or, with null, clear) the favorite cookie. Client-only. */
export function writeFavoriteCookie(json: string | null): void {
  if (typeof document === 'undefined') return;
  if (json) {
    document.cookie = `${FAVORITE_COOKIE}=${encodeURIComponent(json)}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
  } else {
    document.cookie = `${FAVORITE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
}
