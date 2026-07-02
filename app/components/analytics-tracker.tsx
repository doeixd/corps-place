import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  trackPageview,
  initEngagement,
  maybeTrackSearch,
  initWebVitals,
  track,
} from '@/lib/analytics/client';

// ── central filter/interaction tracking ──
// Most interactions on this site are URL-driven (filters, scrubbers, view
// toggles live in search params), so ONE param-diff on every resolved navigation
// covers them all — no per-component wiring, no missed spots. Only allow-listed
// enum-ish params are tracked; free-text params (like `q`, handled separately by
// maybeTrackSearch, which records only length) are excluded, and values are
// clipped defensively.
const TRACKED_PARAMS = [
  'asof', // forecast-as-of scrubber (prediction pages, /rankings)
  'diffbase', // prediction diff-table basis (vs prediction / vs previous show)
  'view', // prediction page view (scores / diff)
  'metric', // /rankings metric
  'div', // /rankings divisions
  'agg', // /rankings aggregation
  'group', // /rankings grouping
  'season', // season pills (/rankings, /events, /scores …)
  'cls', // class filter (/corps directory, /rankings link-ins)
  'cap', // caption picker (/vs)
  'window', // prediction scenario window
  'sort', // table sorts (compact recap)
  'preset', // /predict/ballot corps-set preset
] as const;

let lastParams: Record<string, string | null> = {};
let lastParamsPath = '';
function trackParamInteractions(): void {
  const path = location.pathname;
  const search = new URLSearchParams(location.search);
  const current: Record<string, string | null> = {};
  for (const p of TRACKED_PARAMS) current[p] = search.get(p);
  // A path change is navigation, not an in-page interaction — reset the baseline.
  if (path !== lastParamsPath) {
    lastParamsPath = path;
    lastParams = current;
    return;
  }
  for (const p of TRACKED_PARAMS) {
    if (current[p] !== lastParams[p]) {
      track('filter', {
        param: p,
        value: current[p] === null ? null : String(current[p]).slice(0, 40),
        scope: path,
      });
    }
  }
  lastParams = current;
}

/**
 * Mounts once in the root layout. Fires a pageview on the initial load and on every
 * resolved client navigation (deduped by path), tracks in-page filter/scrubber
 * interactions via search-param diffs, and arms the outbound/engagement listeners.
 * Renders nothing; all work is client-only (the effect never runs on the server),
 * so no analytics code reaches a server render.
 */
export function AnalyticsTracker(): null {
  const router = useRouter();
  useEffect(() => {
    initEngagement();
    initWebVitals();
    let last = '';
    const fire = () => {
      maybeTrackSearch(); // every resolve — debounced; covers ?q= param updates
      trackParamInteractions(); // every resolve — same-path param changes = interactions
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
