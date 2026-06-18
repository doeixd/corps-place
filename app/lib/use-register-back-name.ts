import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { installHistoryTrail, registerEntryName } from './history-trail';

/**
 * Register a display name for the current page's history entry so that, when the
 * user navigates onward and later hits a smart back control, it can read
 * "Back to <name>" (e.g. "Back to Blue Devils @ DCI Finals") instead of the
 * generic section label. No-op until `name` is known, so it's safe to call with
 * a value that resolves after the loader/data settles.
 */
export function useRegisterBackName(name: string | undefined | null): void {
  const router = useRouter();
  useEffect(() => {
    if (!name) return;
    installHistoryTrail(router.history);
    registerEntryName(router.history, name);
  }, [router, name]);
}
