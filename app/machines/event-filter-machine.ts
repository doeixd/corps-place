import { setup, assign } from 'xstate';
import { flipDir, type SortDir, type EventFilterState } from '@/lib/event-filtering';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

export type { SortDir };

/**
 * Filter/sort state for a list of events (season + search + direction), shared
 * by the events directory and a corps's "Appearances" list. Pair with
 * `selectEvents` from `@/lib/event-filtering` to derive the displayed list.
 */
export type EventFilterContext = EventFilterState;

export type EventFilterEvent =
  | { type: 'SET_SEASON'; season: string }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_DIR'; dir: SortDir }
  | { type: 'TOGGLE_DIR' }
  | { type: 'RESET' }
  | SyncEvent<EventFilterContext>;

export interface EventFilterInput {
  season?: string;
  search?: string;
  dir?: SortDir;
}

export const eventFilterMachine = setup({
  types: {
    context: {} as EventFilterContext,
    events: {} as EventFilterEvent,
    input: {} as EventFilterInput,
  },
}).createMachine({
  id: 'eventFilter',
  context: ({ input }) => ({
    season: input?.season ?? 'all',
    search: input?.search ?? '',
    dir: input?.dir ?? 'asc',
  }),
  on: {
    SET_SEASON: { actions: assign({ season: ({ event }) => event.season }) },
    SET_SEARCH: { actions: assign({ search: ({ event }) => event.search }) },
    SET_DIR: { actions: assign({ dir: ({ event }) => event.dir }) },
    TOGGLE_DIR: { actions: assign({ dir: ({ context }) => flipDir(context.dir) }) },
    RESET: {
      actions: assign(() => ({ season: 'all', search: '', dir: 'asc' as SortDir })),
    },
    // URL → machine (see useSearchSync): merge the decoded slice.
    SYNC: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
  },
});

/**
 * Search-param codec for the events directory. `defaultSeason` (the latest
 * season) is kept out of the URL so the default view has a clean URL; `dir=asc`
 * and an empty search are likewise omitted.
 */
export const eventFilterSearchCodec = (
  defaultSeason: string
): SearchCodec<EventFilterContext, { season?: string; q?: string; dir?: 'desc' }> => ({
  encode: (ctx) => ({
    season: ctx.season === defaultSeason ? undefined : ctx.season,
    q: ctx.search || undefined,
    dir: ctx.dir === 'desc' ? 'desc' : undefined,
  }),
  decode: (search) => ({
    season: search.season ?? defaultSeason,
    search: search.q ?? '',
    dir: search.dir ?? 'asc',
  }),
});
