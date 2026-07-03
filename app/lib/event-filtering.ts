import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import * as EventPredicates from '@/predicates/event';
import { todayYmd, startsOnOrAfter } from '@/lib/date';
import type { EventDirectoryRow } from '@/lib/event-directory';

/**
 * Shared event filtering/ordering — the logic behind both the events directory
 * and a corps's "Appearances" list. Filter state lives in `eventFilterMachine`;
 * this module turns that state + a list of events into the displayed list.
 */

export type SortDir = 'asc' | 'desc';

/** Toggle a sort direction. */
export const flipDir = (dir: SortDir): SortDir => (dir === 'asc' ? 'desc' : 'asc');

export interface EventFilterState {
  /** Season value or the `'all'` sentinel. */
  readonly season: string;
  readonly search: string;
  readonly dir: SortDir;
}

// Distinct seasons present, newest first.
export const availableSeasons = (events: readonly EventDirectoryRow[]): string[] =>
  Array.from(new Set(events.map((e) => e.season).filter(Predicate.isString))).sort((a, b) =>
    b.localeCompare(a)
  );

// Sort by date explicitly (slug tiebreak for same-day shows). This used to
// assume the input was already date-asc and just reverse for `desc` — true for
// the loader's query order, but the rows now also arrive from the TanStack DB
// collection, which returns them sorted by key (event_id) and rendered the
// directory alphabetically.
const orderEvents = (
  events: readonly EventDirectoryRow[],
  dir: SortDir
): readonly EventDirectoryRow[] => {
  const sorted = [...events].sort(
    (a, b) =>
      (a.start_date ?? '').localeCompare(b.start_date ?? '') ||
      (a.slug ?? '').localeCompare(b.slug ?? '')
  );
  return Match.value(dir).pipe(
    Match.when('desc', () => sorted.reverse()),
    Match.orElse(() => sorted)
  );
};

// Filter by season + search, then order. Reuses the effect/Predicate refinements
// in `@/predicates/event`, combined with `Predicate.and`.
export const selectEvents = (
  events: readonly EventDirectoryRow[],
  { season, search, dir }: EventFilterState
): readonly EventDirectoryRow[] => {
  const inSeason: Predicate.Predicate<EventDirectoryRow> = EventPredicates.inSeason(season);
  const keep: Predicate.Predicate<EventDirectoryRow> = EventPredicates.hasSearchTerm(search)
    ? Predicate.and(inSeason, EventPredicates.matchesSearch(search))
    : inSeason;
  return orderEvents(events.filter(keep), dir);
};

// The DOM/React key for one event card. Single source of truth shared by the
// grid (`StaggeredGrid getKey`) and `nextUpcomingEventKey` so the value used to
// *locate* a card can never drift from the value used to *render* it. `event_id`
// is the only stable key across season-duplicate rows; `slug` is the fallback.
export const eventCardKey = (event: EventDirectoryRow): string =>
  String(event.event_id ?? event.slug);

// The card key of the next show "about to happen" in a season: the first event
// whose date is today or later, in date order (see `@/lib/date` for the UTC rule;
// mirrors `pickFeaturedEvent` in sdk/src/readModel/builders/home.ts). Returns null
// when nothing is upcoming (e.g. the season is over) — callers decide the fallback.
export const nextUpcomingEventKey = (
  events: readonly EventDirectoryRow[],
  season: string,
  now: Date = new Date()
): string | null => {
  const ref = todayYmd(now);
  const inSeason = EventPredicates.inSeason(season);
  const upcoming = events
    .filter((e) => inSeason(e) && startsOnOrAfter(e.start_date, ref))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return upcoming.length > 0 ? eventCardKey(upcoming[0]) : null;
};
