import type { RouterHistory } from '@tanstack/react-router';

/**
 * Tracks the pathname of each visited history entry so a "smart back" control
 * can tell *where* `history.back()` would land without navigating there.
 *
 * The browser History API can't read other entries, so we record them as the
 * user moves. TanStack stamps every entry with a monotonic `__TSR_index`, which
 * we use as the map key — back() lands on `currentIndex - 1`.
 */

const tracked = new WeakSet<RouterHistory>();
const trails = new WeakMap<RouterHistory, Map<number, string>>();
// Display names a page registered for its own history entry (keyed by index),
// so a smart back control can show the specific page it returns to
// ("Back to Blue Devils") rather than just the section.
const names = new WeakMap<RouterHistory, Map<number, string>>();

function indexOf(history: RouterHistory): number {
  return (history.location.state as { __TSR_index?: number }).__TSR_index ?? 0;
}

/**
 * Begin recording the entry trail for this history instance. Idempotent — the
 * subscription is installed once and lives for the app's lifetime, so the trail
 * keeps filling in even on pages that don't render the back control.
 */
export function installHistoryTrail(history: RouterHistory): void {
  if (tracked.has(history)) return;
  tracked.add(history);
  const trail = new Map<number, string>();
  trails.set(history, trail);
  trail.set(indexOf(history), history.location.pathname);
  history.subscribe(({ location }) => {
    const index = (location.state as { __TSR_index?: number }).__TSR_index ?? 0;
    trail.set(index, location.pathname);
  });
}

/**
 * Pathname of the entry `history.back()` would land on, or `undefined` if we
 * never recorded it (e.g. a session restored mid-stack). Callers treat
 * `undefined` as "unknown" and fall back to default back behavior.
 */
export function previousPathname(history: RouterHistory): string | undefined {
  return trails.get(history)?.get(indexOf(history) - 1);
}

/**
 * Record a display name for the current history entry. Called by pages (via
 * `useRegisterBackName`) so a later page's back control can name where it
 * returns to. Overwrites on re-register so data-driven names stay current.
 */
export function registerEntryName(history: RouterHistory, name: string): void {
  let map = names.get(history);
  if (!map) names.set(history, (map = new Map()));
  map.set(indexOf(history), name);
}

/** Registered display name for the entry `history.back()` would land on. */
export function previousName(history: RouterHistory): string | undefined {
  return names.get(history)?.get(indexOf(history) - 1);
}

// Friendly names for the top-level sections, keyed by first path segment. Used
// to label a smart back control ("Back to Events") from the destination's URL,
// since pages don't expose a readable dynamic title to reuse here.
const SECTION_LABELS: Record<string, string> = {
  '': 'Home',
  corps: 'Corps',
  judges: 'Judges',
  events: 'Events',
};

/** Human label for a pathname's section, e.g. `/events/2026/...` -> "Events". */
export function sectionLabel(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean)[0] ?? '';
  if (segment in SECTION_LABELS) return SECTION_LABELS[segment];
  // Title-case the raw segment as a reasonable default for new sections.
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
