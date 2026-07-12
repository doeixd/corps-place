// Event-time display preference (USER_PROFILE_PLAN D6): venue-local (default —
// what the activity expects) vs the viewer's timezone. Device-local
// (localStorage) for instant reads; account-sync roams it for signed-in users.
import { useSyncExternalStore } from 'react';
import { createStore } from '@xstate/store';

export type TimeDisplayMode = 'venue' | 'local';

const STORAGE_KEY = 'cp_time_display';

const initialMode = (): TimeDisplayMode => {
  if (typeof localStorage === 'undefined') return 'venue';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'venue';
  } catch {
    return 'venue';
  }
};

export const timeDisplayStore = createStore({
  context: { mode: initialMode() },
  on: {
    set: (_context, event: { mode: TimeDisplayMode }) => ({ mode: event.mode }),
  },
});

timeDisplayStore.subscribe((snapshot) => {
  try {
    localStorage.setItem(STORAGE_KEY, snapshot.context.mode);
  } catch {
    /* private mode — in-memory only */
  }
});

const subscribeMode = (onChange: () => void) => {
  const sub = timeDisplayStore.subscribe(onChange);
  return () => sub.unsubscribe();
};

export function useTimeDisplayMode(): TimeDisplayMode {
  return useSyncExternalStore(
    subscribeMode,
    () => timeDisplayStore.getSnapshot().context.mode,
    () => 'venue' as const
  );
}
