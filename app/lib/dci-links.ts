import type { EventDirectoryRow } from '@/lib/event-directory';
import verifiedEventSlugs from '@/lib/dci-verified-event-slugs.json';

// DCI publishes three distinct pages for a competition, all keyed by the same
// **season-prefixed** slug (verified live via Browserbase — see
// sdk/docs/data-integrity-slugs-lineups-aliases.md §3):
//
//   /events/{slug}                 — the event/show page
//   /scores/recap/{slug}           — the judge-breakdown recap
//   /scores/final-scores/{slug}    — the final-score totals
//
// The score pages persist indefinitely, but DCI *removes* the `/events/` page for
// older events (e.g. 2016 events 404 on /events/ while their recap/final-scores
// pages are still live). So the event link can't be inferred from the slug — it
// needs positive, live verification. `competition_slug` is the authoritative
// prefixed slug bridged via `event_to_competition`; we link off it (falling back
// to the route slug) for all three paths.

const DCI_BASE = 'https://www.dci.org';

// Allowlist of event slugs whose dci.org/events page currently returns 2xx/3xx,
// from the Browserbase verification cache (sdk/event-slug-verification-cache.json).
// Regenerate with `npx tsx sdk/scripts/verifyEventLinks.ts`, which rewrites this
// file. We only render the event link for slugs in this set, because a slug being
// absent means either "removed by DCI" or "not yet verified" — both should hide
// the link rather than risk a 404.
const VERIFIED_EVENT_SLUGS = new Set<string>(verifiedEventSlugs as string[]);

export type DciLinks = {
  /** The dci.org/events page, or null when the slug is a known synthetic 404. */
  event: string | null;
  /** The dci.org/scores/recap page, present only when a recap was released. */
  recap: string | null;
  /** The dci.org/scores/final-scores page, present only when scores released. */
  scores: string | null;
};

/**
 * The slug to link an event by: its season-prefixed `competition_slug` (the
 * authoritative target — where scores/recaps live) when bridged, else the given
 * fallback (route param, or the event's own slug). Shared by the dci.org links
 * here and the internal event route so the rule lives in one place.
 */
export const preferredEventSlug = (
  event: Pick<EventDirectoryRow, 'competition_slug'> | null | undefined,
  fallbackSlug: string
): string => event?.competition_slug ?? fallbackSlug;

export const dciLinks = (
  event: Pick<EventDirectoryRow, 'competition_slug' | 'recap_released' | 'scores_released'> | null,
  routeSlug: string,
  // Whether the page actually has recap/score data in hand. This is the
  // authoritative signal that DCI's recap/final-scores pages exist — the
  // `recap_released`/`scores_released` flags on the competitions row are stale or
  // unset for many historical events even when the recap page is live. We OR the
  // two so future events (no data, flags off) still don't get dead links.
  opts?: { hasRecap?: boolean; hasScores?: boolean }
): DciLinks => {
  const slug = preferredEventSlug(event, routeSlug);
  const eventVerified = VERIFIED_EVENT_SLUGS.has(slug);
  const hasRecap = opts?.hasRecap || Boolean(event?.recap_released);
  const hasScores = opts?.hasScores || Boolean(event?.scores_released);
  return {
    event: eventVerified ? `${DCI_BASE}/events/${slug}` : null,
    recap: hasRecap ? `${DCI_BASE}/scores/recap/${slug}` : null,
    scores: hasScores ? `${DCI_BASE}/scores/final-scores/${slug}` : null,
  };
};
