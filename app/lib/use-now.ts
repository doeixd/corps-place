import { useSyncExternalStore } from 'react';

/**
 * A shared, once-per-second clock as an external store — so countdowns re-render
 * without per-component `useEffect`/`setInterval`. One interval backs every
 * subscriber and is cleared when the last one unmounts. SSR returns a stable
 * snapshot (no interval on the server).
 */
const listeners = new Set<() => void>();
let nowMs = Date.now();
let interval: ReturnType<typeof setInterval> | null = null;

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  interval ??= setInterval(() => {
    nowMs = Date.now();
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && interval) {
      clearInterval(interval);
      interval = null;
    }
  };
};

const getSnapshot = (): number => nowMs;

/** Current wall-clock time in ms, re-rendering subscribers about once a second. */
export const useNow = (): number => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
