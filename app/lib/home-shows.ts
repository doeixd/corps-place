import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import * as path from 'node:path';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import {
  buildHomeWeekendShows,
  buildLatestResults,
  buildSeasonStandings,
  buildFeaturedPrediction,
  chooseWeekend,
  type WeekendBucket,
  type WeekendShow,
  type WeekendShowLineupEntry,
  type LatestResults,
  type SeasonStandings,
  type FeaturedPrediction,
} from '@sdk/src/readModel/builders/home.js';
import {
  readHomeWeekendShows,
  readLatestResults,
  readSeasonStandings,
  readFeaturedPrediction,
} from '@sdk/src/readModel/readers.js';

export type {
  WeekendBucket,
  WeekendShow,
  WeekendShowLineupEntry,
  LatestResults,
  SeasonStandings,
  FeaturedPrediction,
};

// The weekend the home carousel features: the current weekend if it has shows,
// else the next upcoming one (chooseWeekend rolls past empty/pre-season gaps).
// null when the season is over.
export type FeaturedWeekend = {
  weekendStart: string;
  weekendEnd: string;
  isCurrentWeekend: boolean;
  shows: WeekendShow[];
} | null;

export class HomeShowsDataError extends Schema.TaggedErrorClass<HomeShowsDataError>()(
  'HomeShowsDataError',
  { message: Schema.String, details: Schema.optional(Schema.Unknown) }
) {}

// Big-DB fallback client (dev / missing read-model). Lazily resolved so importing
// this server module stays browser-safe in the Vite client bundle.
let _bigDb: Client | null = null;
const getBigDb = () => {
  if (!_bigDb) {
    const sdkDir = path.resolve(process.cwd(), 'sdk');
    const dbUrl =
      process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir, 'dci-relational.db')}`;
    _bigDb = createClient({ url: dbUrl });
  }
  return _bigDb;
};

// Read-model fast path with builder fallback — one definition each side
// (READ_MODEL_PLAN §8). The weekend buckets are stored for the whole season and
// the feature weekend is chosen here from `now`, so a stale emit stays correct.
const loadBuckets = (season: string): Effect.Effect<WeekendBucket[], HomeShowsDataError> =>
  Effect.tryPromise({
    try: () =>
      readModelEnabled()
        ? readHomeWeekendShows(getReadModelClient(), season)
        : buildHomeWeekendShows(getBigDb(), season),
    catch: (cause) =>
      new HomeShowsDataError({
        message: `Could not load ${season} weekend shows.`,
        details: String(cause),
      }),
  });

const missingReadModelData = (error: HomeShowsDataError) => {
  const details =
    typeof error.details === 'string'
      ? error.details
      : error.details instanceof Error
        ? error.details.message
        : '';
  return details.includes('no such table') || details.includes('no such column');
};

// 'YYYY-MM-DD' for `d` in US Eastern (DCI is US-based). The server runs UTC, so
// after ~8pm ET a show dated today in local time is already "tomorrow" in UTC —
// anchoring the "today" filter to Eastern keeps today's shows in the section.
const easternDay = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

const makeHomeShowsService = Effect.gen(function* () {
  const weekendShows = Effect.fn('HomeShowsService.weekendShows')(function* (
    season: string,
    now: Date = new Date()
  ) {
    const buckets = yield* loadBuckets(season).pipe(
      Effect.catch((error) =>
        readModelEnabled() && missingReadModelData(error) ? Effect.succeed([]) : Effect.fail(error)
      )
    );
    // "Shows coming up" = today → the upcoming weekend. Drop already-past shows
    // (incl. earlier days of the current week) so the window starts at today, and
    // drop weekends left with nothing. Anchored to Eastern (see easternDay).
    const anchorDay = easternDay(now);
    const anchorNow = new Date(`${anchorDay}T12:00:00.000Z`);
    const upcoming = buckets
      .map((b) => ({ ...b, shows: b.shows.filter((s) => s.startDate.slice(0, 10) >= anchorDay) }))
      .filter((b) => b.shows.length > 0);
    const chosen = chooseWeekend(upcoming, anchorNow);
    if (!chosen) return null as FeaturedWeekend;
    return {
      weekendStart: chosen.bucket.weekendStart,
      weekendEnd: chosen.bucket.weekendEnd,
      isCurrentWeekend: chosen.isCurrentWeekend,
      shows: chosen.bucket.shows,
    };
  });

  const latestResults = Effect.fn('HomeShowsService.latestResults')(function* () {
    return yield* Effect.tryPromise({
      try: () =>
        readModelEnabled()
          ? readLatestResults(getReadModelClient())
          : buildLatestResults(getBigDb()),
      catch: (cause) =>
        new HomeShowsDataError({
          message: 'Could not load latest results.',
          details: String(cause),
        }),
    }).pipe(
      Effect.catch((error) =>
        readModelEnabled() && missingReadModelData(error)
          ? Effect.succeed(null)
          : Effect.fail(error)
      )
    );
  });

  const seasonStandings = Effect.fn('HomeShowsService.seasonStandings')(function* () {
    return yield* Effect.tryPromise({
      try: () =>
        readModelEnabled()
          ? readSeasonStandings(getReadModelClient())
          : buildSeasonStandings(getBigDb()),
      catch: (cause) =>
        new HomeShowsDataError({ message: 'Could not load standings.', details: String(cause) }),
    }).pipe(
      Effect.catch((error) =>
        readModelEnabled() && missingReadModelData(error)
          ? Effect.succeed(null)
          : Effect.fail(error)
      )
    );
  });

  const featuredPrediction = Effect.fn('HomeShowsService.featuredPrediction')(function* (
    now: Date = new Date()
  ) {
    return yield* Effect.tryPromise({
      try: () =>
        readModelEnabled()
          ? readFeaturedPrediction(getReadModelClient(), now)
          : buildFeaturedPrediction(getBigDb(), now),
      catch: (cause) =>
        new HomeShowsDataError({
          message: 'Could not load featured prediction.',
          details: String(cause),
        }),
    }).pipe(
      Effect.catch((error) =>
        readModelEnabled() && missingReadModelData(error)
          ? Effect.succeed(null)
          : Effect.fail(error)
      )
    );
  });

  return { weekendShows, latestResults, seasonStandings, featuredPrediction };
});

export class HomeShowsService extends Context.Service<
  HomeShowsService,
  Effect.Success<typeof makeHomeShowsService>
>()('HomeShowsService') {}

export const HomeShowsServiceLive = Layer.effect(HomeShowsService, makeHomeShowsService);
