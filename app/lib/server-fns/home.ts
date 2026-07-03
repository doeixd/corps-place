import { createServerFn } from '@tanstack/react-start';
import { Effect } from 'effect';
import {
  HomeShowsService,
  HomeShowsServiceLive,
  type FeaturedWeekend,
  type LatestResults,
  type SeasonStandings,
  type FeaturedPrediction,
} from '@/lib/home-shows';
import {
  CorpsDirectoryService,
  CorpsDirectoryServiceLive,
  type CorpsSummary,
} from '@/lib/corps-directory';

export type HomePageData = {
  weekend: FeaturedWeekend;
  latestResults: LatestResults | null;
  standings: SeasonStandings | null;
  featuredPrediction: FeaturedPrediction | null;
  // Corps appearing in the weekend lineups, for logo resolution via the registry.
  lineupCorps: CorpsSummary[];
};

const uniqueKeys = (weekend: FeaturedWeekend): string[] => {
  if (!weekend) return [];
  const keys = new Set<string>();
  for (const show of weekend.shows)
    for (const entry of show.lineup) if (entry.corpsKey) keys.add(entry.corpsKey);
  return [...keys];
};

// One boundary for the home route loader: the featured weekend's shows (with
// venue coords + lineups + the lineup corps for logos), latest results,
// standings, and the featured prediction. SSR'd; the client reorders the weekend
// shows nearest-first if the user shares their location.
export const getHomePageData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HomePageData> => {
    const program = Effect.gen(function* () {
      const home = yield* HomeShowsService;
      const [weekend, latestResults, standings, featuredPrediction] = yield* Effect.all(
        [
          home.weekendShows('2026'),
          home.latestResults(),
          home.seasonStandings(),
          home.featuredPrediction(),
        ],
        { concurrency: 'unbounded' }
      );
      const keys = new Set(uniqueKeys(weekend));
      // Rankings-snapshot corps too, so their logos resolve from the same registry.
      for (const row of standings?.standings ?? []) if (row.corpsKey) keys.add(row.corpsKey);
      const lineupCorps =
        keys.size > 0
          ? yield* Effect.flatMap(CorpsDirectoryService, (s) => s.getCorpsByKeys([...keys]))
          : [];
      return { weekend, latestResults, standings, featuredPrediction, lineupCorps };
    }).pipe(Effect.provide(HomeShowsServiceLive), Effect.provide(CorpsDirectoryServiceLive));
    return Effect.runPromise(program);
  }
);
