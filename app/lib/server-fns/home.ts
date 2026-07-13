import { createServerFn } from '@tanstack/react-start/client';
import { Effect } from 'effect';
import {
  HomeShowsService,
  HomeShowsServiceLive,
  type FeaturedWeekend,
  type LatestResults,
  type SeasonStandings,
  type FeaturedPrediction,
} from '@/lib/home-shows';
import { CorpsDirectoryService, CorpsDirectoryServiceLive } from '@/lib/corps-directory';

// Exactly the fields CorpsRegistryProvider resolves logos from (CorpsLike) —
// the full CorpsSummary for ~114 corps was a large chunk of the home page's
// SSR-inlined loader payload, which sits ahead of the stylesheet in <head>
// and delays first paint on slow connections.
export type LineupCorps = {
  corps_key: string;
  name: string;
  corps_logo: string | null;
  corps_logo_dark: number;
  corps_logo_dark_url: string | null;
};

export type HomePageData = {
  weekend: FeaturedWeekend;
  latestResults: LatestResults | null;
  standings: SeasonStandings | null;
  featuredPrediction: FeaturedPrediction | null;
  // Corps appearing in the weekend lineups, for logo resolution via the registry.
  lineupCorps: LineupCorps[];
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
      const full =
        keys.size > 0
          ? yield* Effect.flatMap(CorpsDirectoryService, (s) => s.getCorpsByKeys([...keys]))
          : [];
      const lineupCorps: LineupCorps[] = full.map((c) => ({
        corps_key: c.corps_key,
        name: c.name,
        corps_logo: c.corps_logo,
        corps_logo_dark: c.corps_logo_dark,
        corps_logo_dark_url: c.corps_logo_dark_url,
      }));
      return { weekend, latestResults, standings, featuredPrediction, lineupCorps };
    }).pipe(Effect.provide(HomeShowsServiceLive), Effect.provide(CorpsDirectoryServiceLive));
    return Effect.runPromise(program);
  }
);
