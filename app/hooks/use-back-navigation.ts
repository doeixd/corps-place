import { useRouter } from '@tanstack/react-router';
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
 * Consumers use it to skip one-shot entrance animations when the user is
 * retracing their steps — replaying a staggered fade on Back feels wrong when
 * the page was already seen. SSR always returns `false` (no history there).
 */
export function useIsBackNavigation(): boolean {
  const router = useRouter();
  return useSyncExternalStore(
    (onChange) =>
      router.history.subscribe(({ action }) => {
        wasBack = action.type === 'BACK';
        onChange();
      }),
    () => wasBack,
    () => false
  );
}

// Module-level so every consumer shares the latest history action; each
// subscription updates it before notifying React to re-read the snapshot.
let wasBack = false;
