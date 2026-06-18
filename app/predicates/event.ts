import * as Predicate from 'effect/Predicate';

export const hasEvents = (context: { events: unknown[] }) =>
  Array.isArray(context.events) && context.events.length > 0;

export const hasRefreshStatus = (context: { refreshStatus: unknown }) =>
  Predicate.isNotNull(context.refreshStatus) && Predicate.isNotUndefined(context.refreshStatus);

export const isRefreshRunning = (context: { refreshStatus: any }) =>
  hasRefreshStatus(context) && context.refreshStatus.status === 'running';

export const canStartRefresh = (context: { refreshStatus: any }) => !isRefreshRunning(context);

export const hasSearchTerm: Predicate.Predicate<string> = (term) =>
  Predicate.isString(term) && term.trim().length > 0;

/** Matches a given season, or every event when `season` is the `all` sentinel. */
export const inSeason = (season: string): Predicate.Predicate<{ season?: string | null }> =>
  season === 'all' ? () => true : (event) => event.season === season;

type SearchableEvent = { name?: string | null; location_city?: string | null };

/** Case-insensitive match of an event's name or city against a search term. */
export const matchesSearch = (term: string): Predicate.Predicate<SearchableEvent> => {
  const needle = term.toLowerCase();
  const fieldMatches = (value: string | null | undefined) =>
    Predicate.isString(value) && value.toLowerCase().includes(needle);
  return (event) => fieldMatches(event.name) || fieldMatches(event.location_city);
};
