import { useState } from 'react';

/**
 * Tiny mutation helper for the seedable row actions (hide/save/revert, etc.).
 *
 * Matches the app's house style — local `busy`/`error` state, a direct
 * try/catch around the server-fn, no toast/global handler. Centralizing it here
 * fixes the previously-uncaught `hide()` path (a rejected write — page lock,
 * stale-write 409 — used to vanish into an unhandled rejection) and removes the
 * same boilerplate repeated in every section's row component.
 *
 *   const { busy, error, run } = useRowMutation();
 *   <button disabled={busy} onClick={() => run(async () => { await save(); onSaved(); })} />
 *   {error ? <p className="text-xs text-destructive">{error}</p> : null}
 */
export function useRowMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — please retry.');
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run, setError };
}
