import { useState } from 'react';

export type AsyncAction<A extends unknown[]> = {
  /** Invoke the wrapped handler; toggles `busy` and captures thrown errors. */
  run: (...args: A) => Promise<void>;
  busy: boolean;
  error: string | null;
  setError: (message: string | null) => void;
};

/**
 * Wrap an async event handler with `busy` + `error` state, so components don't
 * re-implement the try/finally/loading dance. State is driven entirely by the
 * call — no effects. `mapError` turns a thrown Error into a user-facing message
 * (defaults to the raw message).
 */
export function useAsyncAction<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
  mapError: (err: Error) => string = (err) => err.message
): AsyncAction<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action(...args);
    } catch (err) {
      setError(mapError(err as Error));
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}

/**
 * Map a thrown server-fn error to a friendly message by substring-matching its
 * message against `cases` (server fns throw `CONFLICT:reason`-style codes). Falls
 * back to `fallback` (or the raw message) when nothing matches.
 */
export function matchMessage(err: Error, cases: Record<string, string>, fallback?: string): string {
  for (const [needle, message] of Object.entries(cases)) {
    if (err.message.includes(needle)) return message;
  }
  return fallback ?? err.message;
}
