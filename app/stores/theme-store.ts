import { createStore } from '@xstate/store';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'corps-place-theme';

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
 * Apply a theme to the document and persist it. No-op on the server.
 *
 * Color swaps are applied instantly: without this, every element with a
 * `transition-colors` (buttons, cards, borders, links…) animates its color
 * independently on the flip, producing a staggered "nested transitions" smear.
 * We disable transitions for the duration of the class change, then restore
 * them on the next frame so genuine hover/focus transitions still work.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const style = document.createElement('style');
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none !important}'));
  document.head.appendChild(style);

  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;

  // Force a reflow so the "no transition" style is committed before we remove it,
  // then drop it on the next frame to re-enable transitions.
  void window.getComputedStyle(style).opacity;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => style.remove());
  });

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private mode, disabled cookies, etc.)
  }
}

export const themeStore = createStore({
  context: { theme: getInitialTheme() },
  on: {
    set: (context, event: { theme: Theme }) => ({ ...context, theme: event.theme }),
    toggle: (context) => ({ ...context, theme: context.theme === 'dark' ? 'light' : 'dark' }),
  },
});

// Reflect every change to the DOM + localStorage (client only).
themeStore.subscribe((snapshot) => applyTheme(snapshot.context.theme));
