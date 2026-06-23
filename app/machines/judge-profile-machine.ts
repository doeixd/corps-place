import { setup, assign } from 'xstate';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

// View state for a single judge's profile page: which season, how the assignments
// are grouped, and which captions are selected (empty = all). URL-synced via the
// codec below + useSearchSync, mirroring the directory pages so every filtered
// surface shares one mechanism.

export type JudgeProfileGroupBy = 'show' | 'corps';

export type JudgeProfileContext = {
  season: string; // a season year, or the 'all' sentinel
  groupBy: JudgeProfileGroupBy;
  captions: string[]; // selected caption names; empty means "no filter"
};

export type JudgeProfileEvent =
  | { type: 'SET_SEASON'; season: string }
  | { type: 'SET_GROUP_BY'; groupBy: JudgeProfileGroupBy }
  | { type: 'SET_CAPTIONS'; captions: string[] }
  | { type: 'RESET' }
  | SyncEvent<JudgeProfileContext>;

export interface JudgeProfileInput {
  season?: string;
  groupBy?: JudgeProfileGroupBy;
  captions?: string[];
}

export const judgeProfileMachine = setup({
  types: {
    context: {} as JudgeProfileContext,
    events: {} as JudgeProfileEvent,
    input: {} as JudgeProfileInput,
  },
}).createMachine({
  id: 'judgeProfile',
  context: ({ input }) => ({
    season: input?.season ?? 'all',
    groupBy: input?.groupBy ?? 'show',
    captions: input?.captions ?? [],
  }),
  on: {
    SET_SEASON: { actions: assign({ season: ({ event }) => event.season }) },
    SET_GROUP_BY: { actions: assign({ groupBy: ({ event }) => event.groupBy }) },
    SET_CAPTIONS: { actions: assign({ captions: ({ event }) => event.captions }) },
    RESET: {
      actions: assign(() => ({
        season: 'all',
        groupBy: 'show' as JudgeProfileGroupBy,
        captions: [] as string[],
      })),
    },
    SYNC: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
  },
});

export const judgeProfileSearchCodec = (): SearchCodec<
  JudgeProfileContext,
  { season?: string; groupBy?: JudgeProfileGroupBy; captions?: string }
> => ({
  // Defaults (all seasons, by-show, no caption filter) are omitted to keep URLs clean.
  encode: (ctx) => ({
    season: ctx.season === 'all' ? undefined : ctx.season,
    groupBy: ctx.groupBy === 'show' ? undefined : 'corps',
    captions: ctx.captions.length ? ctx.captions.join(',') : undefined,
  }),
  decode: (search) => ({
    season: search.season ?? 'all',
    groupBy: search.groupBy === 'corps' ? 'corps' : 'show',
    captions: search.captions ? search.captions.split(',').filter(Boolean) : [],
  }),
});
