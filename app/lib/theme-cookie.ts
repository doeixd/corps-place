// The chosen theme is persisted in a cookie (not localStorage) so the server can
// read it during SSR and render the correct `.dark` class on <html> in the initial
// HTML — no flash, and the markup matches before the no-flash script even runs.
// When there's no cookie (user never picked), the theme follows the OS preference,
// which only the client knows, so the no-flash script still resolves that case.
import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'cp_theme';
const MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/** Read the explicitly-chosen theme (or null if the user hasn't picked one). */
export const readThemeCookie = createIsomorphicFn()
  .server((): Theme | null => normalize(getCookie(THEME_COOKIE)))
  .client((): Theme | null => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + THEME_COOKIE + '=([^;]*)'));
    return m ? normalize(decodeURIComponent(m[1])) : null;
  });

/** Persist the chosen theme. Client-only. */
export function writeThemeCookie(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
}

function normalize(value: string | null | undefined): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}
