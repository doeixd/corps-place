// Cross-device preference roaming (USER_PROFILE_PLAN Phase 3 / D4).
//
// For signed-in users only: on start, pull user_preferences from the server and
// MERGE with local device state — union for bookmarks (newest addedAt wins per
// product), fill-if-absent for the favorite corps (a locally-chosen favorite is
// never overwritten: it drives the current session's theming), server-wins for
// scalar prefs the device hasn't customized. Afterwards, subscribe to the
// stores and push debounced snapshots back up. Cookies/localStorage remain the
// fast path — the server copy is the roaming backup.
//
// Mounted from __root (client-only effect), gated on the maybeSignedIn cookie
// hint so anonymous visitors never pay the fetch.

import { bookmarkStore, type BookmarkItem } from '@/stores/bookmark-store';
import {
  favoriteCorpsStore,
  type PersistedFavorite,
} from '@/stores/favorite-corps-store';
import { timeDisplayStore, type TimeDisplayMode } from '@/stores/time-display-store';

interface RoamingPrefs {
  v: 1;
  favorite?: PersistedFavorite | null;
  bookmarks?: BookmarkItem[];
  timeDisplay?: TimeDisplayMode;
}

const MAX_SYNCED_BOOKMARKS = 200;
const PUSH_DEBOUNCE_MS = 4000;

const snapshot = (): RoamingPrefs => ({
  v: 1,
  favorite: favoriteCorpsStore.getSnapshot().context.favorite,
  bookmarks: bookmarkStore.getSnapshot().context.items.slice(0, MAX_SYNCED_BOOKMARKS),
  timeDisplay: timeDisplayStore.getSnapshot().context.mode,
});

const mergeBookmarks = (local: readonly BookmarkItem[], remote: BookmarkItem[]): BookmarkItem[] => {
  const byId = new Map<string, BookmarkItem>();
  for (const item of [...remote, ...local]) {
    const cur = byId.get(item.productId);
    if (!cur || item.addedAt > cur.addedAt) byId.set(item.productId, item);
  }
  return [...byId.values()]
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
    .slice(0, MAX_SYNCED_BOOKMARKS);
};

export function startAccountSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  let cancelled = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPushed = '';
  const subs: { unsubscribe: () => void }[] = [];

  const push = async () => {
    const prefsJson = JSON.stringify(snapshot());
    if (prefsJson === lastPushed) return;
    try {
      const { saveMyPreferences } = await import('@/lib/server-fns/account');
      await saveMyPreferences({ data: { prefsJson } });
      lastPushed = prefsJson;
    } catch {
      /* offline / signed out — retry on the next change */
    }
  };

  const schedulePush = () => {
    if (cancelled) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push(), PUSH_DEBOUNCE_MS);
  };

  // Flush a pending debounced push when the tab hides — otherwise a change made
  // <4s before closing/navigating away is lost, and the next merge resurrects
  // the old state (e.g. a just-removed bookmark coming back).
  const onHide = () => {
    if (document.visibilityState === 'hidden' && pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
      void push();
    }
  };
  document.addEventListener('visibilitychange', onHide);

  void (async () => {
    try {
      const { getMyPreferences } = await import('@/lib/server-fns/account');
      const res = await getMyPreferences();
      if (cancelled || !res.signedIn) return;

      if (res.prefsJson) {
        let remote: RoamingPrefs | null = null;
        try {
          remote = JSON.parse(res.prefsJson) as RoamingPrefs;
        } catch {
          remote = null;
        }
        if (remote && remote.v === 1) {
          // Bookmarks: union (newest wins per product).
          const merged = mergeBookmarks(
            bookmarkStore.getSnapshot().context.items,
            Array.isArray(remote.bookmarks) ? remote.bookmarks : []
          );
          bookmarkStore.trigger.hydrate({ items: merged });

          // Favorite: fill only if this device has none (a local choice drives
          // the live theming and must never be yanked out from under the user).
          if (!favoriteCorpsStore.getSnapshot().context.favorite && remote.favorite) {
            favoriteCorpsStore.trigger.hydrate({ favorite: remote.favorite });
          }

          // Time display: server-wins unless this device explicitly set one.
          let deviceSet = false;
          try {
            deviceSet = localStorage.getItem('cp_time_display') != null;
          } catch {
            /* ignore */
          }
          if (!deviceSet && (remote.timeDisplay === 'local' || remote.timeDisplay === 'venue')) {
            timeDisplayStore.trigger.set({ mode: remote.timeDisplay });
          }
        }
      }

      // Record the post-merge state as pushed, then watch for changes.
      lastPushed = JSON.stringify(snapshot());
      if (lastPushed !== (res.prefsJson ?? '')) void push();
      subs.push(bookmarkStore.subscribe(schedulePush));
      subs.push(favoriteCorpsStore.subscribe(schedulePush));
      subs.push(timeDisplayStore.subscribe(schedulePush));
    } catch {
      /* network hiccup — device-local behavior is the fallback */
    }
  })();

  return () => {
    cancelled = true;
    document.removeEventListener('visibilitychange', onHide);
    if (pushTimer) clearTimeout(pushTimer);
    for (const s of subs) s.unsubscribe();
  };
}
