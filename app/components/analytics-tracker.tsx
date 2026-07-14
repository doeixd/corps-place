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

// Coarse route bucket for nav-timing aggregation: collapse detail-page slugs so
// `/corps/bluecoats` and `/corps/cavaliers` both report as `/corps/*` (bounded
// cardinality, groupable). Keeps the first segment; a slug-like second segment
// (has a digit, a hyphen, or is long) becomes `*`.
function navBucket(path: string): string {
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  const isSlug = (s: string) => /[-\d]/.test(s) || s.length > 14;
  if (segs.length === 1) return '/' + segs[0];
  return '/' + segs[0] + (isSlug(segs[1]!) ? '/*' : '/' + segs[1]);
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
    // Soft-navigation timing: onBeforeNavigate → onResolved is the loader +
    // route-chunk-load time (what the user waits through before the page shows).
    let navStart = 0;
    let navFrom = '';
    const fire = () => {
      // Record the just-completed navigation's duration (client nav only —
      // navStart is 0 on the initial hard load, so nothing fires there).
      if (navStart > 0) {
        const ms = Math.round(performance.now() - navStart);
        const to = location.pathname;
        // Real route changes only, and drop absurd spans (backgrounded tab).
        if (ms >= 0 && ms < 30_000 && to !== navFrom) {
          track('navigation', { to: navBucket(to), ms });
        }
        navStart = 0;
      }
      maybeTrackSearch(); // every resolve — debounced; covers ?q= param updates
      trackParamInteractions(); // every resolve — same-path param changes = interactions
      const path = location.pathname;
      if (path === last) return; // ignore same-path re-resolves (search/hash changes)
      last = path;
      trackPageview(path);
    };
    fire(); // initial load
    const unsubResolved = router.subscribe('onResolved', fire);
    const unsubBefore = router.subscribe('onBeforeNavigate', () => {
      navStart = performance.now();
      navFrom = location.pathname;
    });
    return () => {
      unsubResolved();
      unsubBefore();
    };
  }, [router]);
  return null;
}
