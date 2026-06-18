import { setup, assign } from 'xstate';
import { flipDir, type SortDir } from '@/lib/event-filtering';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

export type JudgeSortField = 'name' | 'assignments';

export type JudgeFilterContext = {
  season: string;
  search: string;
  sortField: JudgeSortField;
  sortDir: SortDir;
};

export type JudgeFilterEvent =
  | { type: 'SET_SEASON'; season: string }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_SORT_FIELD'; sortField: JudgeSortField }
  | { type: 'SET_SORT_DIR'; sortDir: SortDir }
  | { type: 'TOGGLE_SORT_DIR' }
  | { type: 'RESET' }
  | SyncEvent<JudgeFilterContext>;

export interface JudgeFilterInput {
  season?: string;
  search?: string;
  sortField?: JudgeSortField;
  sortDir?: SortDir;
}

export const judgeFilterMachine = setup({
  types: {
    context: {} as JudgeFilterContext,
    events: {} as JudgeFilterEvent,
    input: {} as JudgeFilterInput,
  },
}).createMachine({
  id: 'judgeFilter',
  context: ({ input }) => ({
    season: input?.season ?? 'all',
    search: input?.search ?? '',
    sortField: input?.sortField ?? 'assignments',
    sortDir: input?.sortDir ?? 'desc',
  }),
  on: {
    SET_SEASON: { actions: assign({ season: ({ event }) => event.season }) },
    SET_SEARCH: { actions: assign({ search: ({ event }) => event.search }) },
    SET_SORT_FIELD: { actions: assign({ sortField: ({ event }) => event.sortField }) },
    SET_SORT_DIR: { actions: assign({ sortDir: ({ event }) => event.sortDir }) },
    TOGGLE_SORT_DIR: { actions: assign({ sortDir: ({ context }) => flipDir(context.sortDir) }) },
    RESET: {
      actions: assign(() => ({
        season: 'all',
        search: '',
        sortField: 'assignments' as JudgeSortField,
        sortDir: 'desc' as SortDir,
      })),
    },
    SYNC: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
  },
});

export const judgeFilterSearchCodec = (
  defaultSeason: string
): SearchCodec<
  JudgeFilterContext,
  { season?: string; q?: string; sort?: string; dir?: 'asc' }
> => ({
  encode: (ctx) => ({
    season: ctx.season === defaultSeason ? undefined : ctx.season,
    q: ctx.search || undefined,
    sort: ctx.sortField === 'assignments' ? undefined : 'name',
    dir: ctx.sortDir === 'desc' ? undefined : ('asc' as const),
  }),
  decode: (search) => ({
    season: search.season ?? defaultSeason,
    search: search.q ?? '',
    sortField: search.sort === 'name' ? 'name' : 'assignments',
    sortDir: search.dir === 'asc' ? 'asc' : 'desc',
  }),
});
