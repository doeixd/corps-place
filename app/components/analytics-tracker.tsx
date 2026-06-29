import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { trackPageview, initEngagement, maybeTrackSearch } from '@/lib/analytics/client';

/**
 * Mounts once in the root layout. Fires a pageview on the initial load and on every
 * resolved client navigation (deduped by path), and arms the outbound/engagement
 * listeners. Renders nothing; all work is client-only (the effect never runs on the
 * server), so no analytics code reaches a server render.
 */
export function AnalyticsTracker(): null {
  const router = useRouter();
  useEffect(() => {
    initEngagement();
    let last = '';
    const fire = () => {
      maybeTrackSearch(); // every resolve — debounced; covers ?q= param updates
      const path = location.pathname;
      if (path === last) return; // ignore same-path re-resolves (search/hash changes)
      last = path;
      trackPageview(path);
    };
    fire(); // initial load
    const unsub = router.subscribe('onResolved', fire);
    return unsub;
  }, [router]);
  return null;
}
