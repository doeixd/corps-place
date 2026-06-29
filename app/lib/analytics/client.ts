/**
 * Client-side analytics beacon. CLIENT-ONLY — imports nothing server-side, so it
 * never leaks node/db code into a shared chunk. Sends tiny payloads to /api/collect
 * via sendBeacon (survives page unload); the server derives brand + visitor hash.
 *
 * Cookieless + privacy-respecting: stores nothing, sets no cookie, and no-ops when
 * the browser signals Do Not Track.
 */

const ENDPOINT = '/api/collect';

const dnt = (): boolean =>
  typeof navigator !== 'undefined' &&
  // covers the standard + legacy vendor-prefixed flags
  (navigator.doNotTrack === '1' ||
    (navigator as { msDoNotTrack?: string }).msDoNotTrack === '1' ||
    (window as { doNotTrack?: string }).doNotTrack === '1');

const device = (): 'mobile' | 'tablet' | 'desktop' => {
  const w = window.innerWidth;
  return w < 640 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';
};

const send = (payload: Record<string, unknown>): void => {
  if (typeof window === 'undefined' || dnt()) return;
  try {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
    // Fallback for browsers where sendBeacon is unavailable/blocked.
    void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } });
  } catch {
    /* analytics is best-effort on the client too */
  }
};

// ── engagement state for the current page view ──
let enteredAt = 0;
let maxScroll = 0;
let lastLeavePath = '';
// The path of the page currently being viewed. Tracked explicitly because by the
// time a navigation resolves, location.pathname is already the NEXT page — so a
// 'leave' flush must use this, not location, or it mislabels the page being left.
let currentPath = '';
// document.referrer doesn't change across SPA navigations, so only the FIRST
// pageview of a visit carries the referrer; later ones would over-count it.
let firstView = true;

const scrollPct = (): number => {
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  if (scrollable <= 0) return 100; // short pages count as fully seen
  return Math.min(100, Math.round((doc.scrollTop / scrollable) * 100));
};

const onScroll = (): void => {
  const p = scrollPct();
  if (p > maxScroll) maxScroll = p;
};

/** Flush a 'leave' event (time on page + max scroll depth) for the current path. */
const flushLeave = (): void => {
  if (!enteredAt || !currentPath) return;
  if (currentPath === lastLeavePath) return; // dedupe pagehide + visibilitychange
  lastLeavePath = currentPath;
  send({
    type: 'event',
    name: 'leave',
    path: currentPath, // the page being LEFT, not location (already the next page)
    device: device(),
    props: { seconds: Math.round((Date.now() - enteredAt) / 1000), scroll: maxScroll },
  });
};

/** Record a pageview + reset engagement counters for the new path. */
export function trackPageview(path: string): void {
  // Flush the previous page's engagement (keyed to currentPath) before switching.
  flushLeave();
  currentPath = path;
  enteredAt = Date.now();
  maxScroll = 0;
  lastLeavePath = '';
  send({ type: 'pageview', path, ref: firstView ? document.referrer : '', device: device() });
  firstView = false;
}

/** Record an arbitrary client domain event. */
export function track(name: string, props?: Record<string, unknown>): void {
  send({ type: 'event', name, path: location.pathname, device: device(), props: props ?? null });
}

// ── search detection ──
// Directory searches across the site live in the `?q=` param. We track them
// centrally + debounced (so per-keystroke param updates collapse to one event) and
// record only the QUERY LENGTH + page scope — never the term itself (privacy).
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let lastSearchKey = '';
export function maybeTrackSearch(): void {
  if (typeof window === 'undefined') return;
  const scope = location.pathname;
  const q = (new URLSearchParams(location.search).get('q') ?? '').trim();
  const key = `${scope}|${q.toLowerCase()}`;
  if (!q || key === lastSearchKey) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    lastSearchKey = key;
    track('search', { scope, len: q.length }); // scope/len captured at schedule time
  }, 800);
}

let wired = false;
/** Attach outbound-link + engagement listeners once. Safe to call repeatedly. */
export function initEngagement(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;

  // Outbound link clicks (delegated, capture phase so it runs before navigation).
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      try {
        const url = new URL(a.href, location.href);
        if (url.hostname && url.hostname !== location.hostname && /^https?:$/.test(url.protocol)) {
          track('outbound', { url: url.href.slice(0, 256), host: url.hostname });
        }
      } catch {
        /* ignore malformed hrefs */
      }
    },
    { capture: true }
  );

  // Engagement flush on tab-hide / unload.
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLeave();
  });
  window.addEventListener('pagehide', flushLeave);
}
