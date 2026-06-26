import { createStore } from '@xstate/store';
import { readThemeCookie, writeThemeCookie } from '@/lib/theme-cookie';
import type { Theme, ThemePreference } from '@/lib/theme-cookie';

export type { Theme, ThemePreference };

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

function getInitialPreference(): ThemePreference {
  if (typeof document === 'undefined') return 'system';
  return readThemeCookie() ?? 'system';
}

/**
 * Read the theme the no-FOUC inline script (see `__root.tsx`) already committed
 * to the DOM. On the server there is no document, so default to `light` — the
 * client store re-syncs from the `.dark` class on mount, so SSR/CSR agree.
 */
export function getInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Apply a theme to the document. No-op on the server.
 *
 * Color swaps are applied instantly: without this, every element with a
 * `transition-colors` (buttons, cards, borders, links…) animates its color
 * independently on the flip, producing a staggered "nested transitions" smear.
 * We disable transitions for the duration of the class change, then restore
 * them on the next frame so genuine hover/focus transitions still work.
 */
let removeTransitionGuardFrame: number | null = null;

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const transitionRoot = document.body;

  if (removeTransitionGuardFrame !== null) cancelAnimationFrame(removeTransitionGuardFrame);
  transitionRoot.classList.add('theme-switching');
  void transitionRoot.offsetHeight;

  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;

  removeTransitionGuardFrame = requestAnimationFrame(() => {
    transitionRoot.classList.remove('theme-switching');
    removeTransitionGuardFrame = null;
  });
}

const initialPreference = getInitialPreference();

export const themeStore = createStore({
  context: {
    theme: getInitialTheme(),
    preference: initialPreference,
  },
  on: {
    set: (context, event: { theme: Theme }) => ({
      ...context,
      theme: event.theme,
      preference: event.theme,
    }),
    toggle: (context) => {
      const theme = context.theme === 'dark' ? 'light' : 'dark';
      return { ...context, theme, preference: theme };
    },
    followSystem: (context) => ({
      ...context,
      preference: 'system' as const,
      theme: resolveTheme('system', getSystemDark()),
    }),
    systemChanged: (context, event: { dark: boolean }) =>
      context.preference === 'system'
        ? { ...context, theme: resolveTheme('system', event.dark) }
        : context,
  },
});

// Reflect every change to the DOM + cookie (client only).
themeStore.subscribe((snapshot) => {
  applyTheme(snapshot.context.theme);
  writeThemeCookie(snapshot.context.preference);
});

if (typeof window !== 'undefined') {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', (event) => {
    themeStore.trigger.systemChanged({ dark: event.matches });
  });
}
