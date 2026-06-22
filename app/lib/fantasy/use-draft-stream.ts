import { useMemo, useSyncExternalStore } from 'react';
import type { DraftSnapshot } from './draft-engine';

/**
 * Subscribe to a league's live draft SSE channel as an external store — so the
 * EventSource lifecycle (open on first subscriber, close on last) rides
 * `useSyncExternalStore` instead of a `useEffect`. The server broadcasts a full
 * snapshot on every `pick`, so the store just replaces its value; `state` events
 * patch the draft status (pause/resume/complete).
 */
function makeDraftStore(leagueId: string, initial: DraftSnapshot | null) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  let source: EventSource | null = null;
  let refCount = 0;

  const emit = () => {
    for (const l of listeners) l();
  };
  const replace = (e: MessageEvent) => {
    try {
      snapshot = JSON.parse(e.data) as DraftSnapshot;
      emit();
    } catch {
      // ignore malformed frame
    }
  };
  const patchState = (e: MessageEvent) => {
    try {
      const { status } = JSON.parse(e.data) as { status: string };
      if (snapshot?.draft) {
        snapshot = { ...snapshot, draft: { ...snapshot.draft, status } };
        emit();
      }
    } catch {
      // ignore
    }
  };

  const subscribe = (onChange: () => void): (() => void) => {
    listeners.add(onChange);
    if (refCount++ === 0 && typeof EventSource !== 'undefined') {
      source = new EventSource(`/api/fantasy/draft/${leagueId}/stream`);
      source.addEventListener('snapshot', replace);
      source.addEventListener('pick', replace);
      source.addEventListener('state', patchState);
    }
    return () => {
      listeners.delete(onChange);
      if (--refCount === 0 && source) {
        source.close();
        source = null;
      }
    };
  };

  return { subscribe, getSnapshot: () => snapshot };
}

/** Live draft snapshot, seeded by the loader value and kept fresh over SSE. */
export function useDraftStream(
  leagueId: string,
  initial: DraftSnapshot | null
): DraftSnapshot | null {
  const store = useMemo(() => makeDraftStore(leagueId, initial), [leagueId, initial]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => initial);
}
