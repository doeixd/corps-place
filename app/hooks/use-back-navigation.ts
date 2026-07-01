import type { RouterHistory } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the *current* location was reached via the browser Back button.
 *
 * `@tanstack/history` classifies popstate navigations as distinct `BACK` /
 * `FORWARD` actions (delta ±1), so we can tell a genuine back-press apart from a
 * forward-press or a normal push/replace. The flag stays true only until the
 * next navigation of any other kind (a link click = `PUSH`, an in-place filter
 * update = `REPLACE`), so entering a page via Back reads `true` while any
 * subsequent interaction on that page flips it back to `false`.
 *
 * The history subscription must be **persistent**, not tied to the lifetime of
 * whichever component reads the flag — otherwise navigating Back *from* a page
 * that has no consumer means nobody is listening and the `BACK` action is
 * missed. So {@link trackBackNavigation} is wired once in the always-mounted
 * root route, and consumers read the shared module-level flag.
 *
 * Consumers use it to skip one-shot entrance animations when the user is
 * retracing their steps — replaying a staggered fade on Back feels wrong when
 * the page was already seen. SSR always returns `false` (no history there).
 */
export function useIsBackNavigation(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => wasBack,
    () => false
  );
}

/**
 * Wire the shared flag to the router history. Call once from the root route so
 * every BACK/FORWARD/PUSH/REPLACE is observed regardless of which page is
 * mounted. Returns an unsubscribe function.
 */
export function trackBackNavigation(history: RouterHistory): () => void {
  return history.subscribe(({ action }) => {
    const next = action.type === 'BACK';
    if (next === wasBack) return;
    wasBack = next;
    listeners.forEach((l) => l());
  });
}

let wasBack = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}
