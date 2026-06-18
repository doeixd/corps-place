import { DateTime, Duration, Effect, Order, Schedule } from "effect";

import type { Competition, CorpsScore, Event } from "./domain.js";
import {
  buildCompetitionRecapSummary,
  buildRecapTable,
  type CompetitionRecapSummary,
  type RecapTableRow,
} from "./recapSummary.js";
import { buildSeasonDataset } from "./season.js";
import {
  buildSeasonRankings,
  type RankingOptions,
  type SeasonRankingSnapshot,
  type SeasonRankingTimeline,
} from "./ranking.js";
import { DciApi } from "./service.js";
import type { DciError } from "./errors.js";

const parseSeason = (value: string) => {
  const numeric = Number(value.replace(/\D+/g, ""));
  return Number.isFinite(numeric) ? numeric : undefined;
};

const resolveSeason = (season?: string) =>
  season ? Effect.succeed(season) : getLatestSeason();

const parseEventStartDate = (event: Event) => {
  try {
    return DateTime.makeUnsafe(event.eDTStartTimeForAPI);
  } catch {
    return undefined;
  }
};

export const getLatestSeason = (): Effect.Effect<
  string | undefined,
  DciError,
  DciApi
> =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const seasons = yield* (api.getSeasons());
    if (seasons.length === 0) {
      return undefined;
    }
    const sorted = [...seasons].sort((a, b) => {
      const yearA = parseSeason(a);
      const yearB = parseSeason(b);
      if (yearA !== undefined && yearB !== undefined) {
        return yearB - yearA;
      }
      if (yearA !== undefined) return -1;
      if (yearB !== undefined) return 1;
      return b.localeCompare(a);
    });
    return sorted[0];
  });

const selectLatestCompetition = (
  competitions: ReadonlyArray<Competition>,
  filter?: (competition: Competition) => boolean,
) => {
  const competitionOrder = Order.mapInput(
    Order.Number,
    (competition: Competition) => competition.date.getTime(),
  );
  const ordered = competitions
    .filter((competition) => competition.recapReleased)
    .filter((competition) => (filter ? filter(competition) : true))
    .sort((self, that) => competitionOrder(that, self));
  return ordered[0];
};

export interface LatestRecapOptions {
  readonly season?: string;
  readonly filter?: (competition: Competition) => boolean;
}

export interface LatestRecapResult {
  readonly competition: Competition;
  readonly scores: ReadonlyArray<CorpsScore>;
  readonly summary: CompetitionRecapSummary;
}

export const getLatestRecap = (
  options?: LatestRecapOptions,
): Effect.Effect<LatestRecapResult | undefined, DciError, DciApi> =>
  Effect.gen(function* () {
    const season = yield* (resolveSeason(options?.season));
    if (!season) return undefined;
    const api = yield* (DciApi);
    const competitions = yield* (api.getCompetitions(season));
    const latest = selectLatestCompetition(competitions, options?.filter);
    if (!latest) return undefined;
    const scores = yield* (api.getCompetitionRecap(latest.slug));
    if (scores.length === 0) return undefined;
    const summary = buildCompetitionRecapSummary(latest, scores);
    return {
      competition: latest,
      scores,
      summary,
    };
  });

export interface CurrentStandingsOptions extends LatestRecapOptions {
  readonly tableCaptions?: ReadonlyArray<string>;
}

export interface CurrentStandingsResult {
  readonly standings: ReadonlyArray<RecapTableRow>;
  readonly recap: CompetitionRecapSummary;
}

export const getCurrentStandings = (
  options?: CurrentStandingsOptions,
): Effect.Effect<CurrentStandingsResult | undefined, DciError, DciApi> =>
  Effect.gen(function* () {
    const latest = yield* (getLatestRecap(options));
    if (!latest) return undefined;
    const standings = buildRecapTable(latest.summary, options?.tableCaptions);
    return {
      standings,
      recap: latest.summary,
    };
  });

export interface CurrentSeasonRankingOptions {
  readonly season?: string;
  readonly ranking?: RankingOptions;
}

export const getCurrentSeasonRankings = (
  options?: CurrentSeasonRankingOptions,
): Effect.Effect<SeasonRankingTimeline | undefined, DciError, DciApi> =>
  Effect.gen(function* () {
    const season = yield* (resolveSeason(options?.season));
    if (!season) return undefined;
    const dataset = yield* (buildSeasonDataset(season));
    if (dataset.recaps.length === 0) return undefined;
    const timeline = yield* buildSeasonRankings(season, dataset, options?.ranking);
    return timeline;
  });

export const getCurrentRankings = (
  options?: CurrentSeasonRankingOptions,
): Effect.Effect<SeasonRankingSnapshot | undefined, DciError, DciApi> =>
  Effect.gen(function* () {
    const timeline = yield* (getCurrentSeasonRankings(options));
    if (!timeline || timeline.snapshots.length === 0) return undefined;
    return timeline.snapshots[timeline.snapshots.length - 1];
  });

export interface LatestRecapWorkflowOptions extends LatestRecapOptions {
  readonly pollIntervalMs?: number;
  readonly emitOnStart?: boolean;
  readonly initialSlug?: string;
}

export const watchLatestRecaps = (
  handler: (result: LatestRecapResult) => Effect.Effect<void, DciError>,
  options?: LatestRecapWorkflowOptions,
): Effect.Effect<void, DciError, DciApi> =>
  Effect.gen(function* () {
    let lastSlug: string | undefined = options?.initialSlug;
    let emitted = false;
    const interval = options?.pollIntervalMs
      ? Duration.millis(options.pollIntervalMs)
      : Duration.minutes(5);

    const tick = getLatestRecap(options).pipe(
      Effect.flatMap((latest) => {
        if (!latest) {
          return Effect.void;
        }
        if (lastSlug === latest.competition.slug) {
          return Effect.void;
        }
        const shouldEmit = emitted || options?.emitOnStart !== false;
        lastSlug = latest.competition.slug;
        emitted = true;
        return shouldEmit ? handler(latest) : Effect.void;
      }),
    );

    return tick.pipe(Effect.repeat(Schedule.spaced(interval)));
  });

export interface LatestEventOptions {
  readonly season?: string;
  readonly includePast?: boolean;
  readonly perPage?: number;
}

export const getLatestEvent = (
  options?: LatestEventOptions,
): Effect.Effect<Event | undefined, DciError, DciApi> =>
  Effect.gen(function* () {
    const season = yield* (resolveSeason(options?.season));
    if (!season) return undefined;
    const api = yield* (DciApi);
    const events = yield* api.listEvents({
      season,
      sort: "startDate",
      perPage: options?.perPage ?? 50,
    });
    const now = yield* (DateTime.now);
    const withDates = events.flatMap((event) => {
      const date = parseEventStartDate(event);
      return date ? [{ event, date }] : [];
    });

    const upcoming = withDates
      .filter((entry) => DateTime.Order(entry.date, now) >= 0)
      .sort((self, that) => DateTime.Order(self.date, that.date));

    if (upcoming.length > 0) {
      return upcoming[0]!.event;
    }

    if (!options?.includePast) {
      return undefined;
    }

    const recent = withDates
      .filter((entry) => DateTime.Order(entry.date, now) < 0)
      .sort((self, that) => DateTime.Order(that.date, self.date));
    return recent[0]?.event;
  });

export interface ClosestEventsOptions {
  readonly season?: string;
  readonly windowMs?: number;
  readonly perPage?: number;
  readonly limit?: number;
}

export const getClosestEvents = (
  anchor: Date,
  windowLengthMs: number,
  options?: ClosestEventsOptions,
): Effect.Effect<readonly Event[], DciError, DciApi> =>
  Effect.gen(function* () {
    const season = yield* (resolveSeason(options?.season));
    if (!season) return [];
    const api = yield* (DciApi);
    const events = yield* api.listEvents({
      season,
      sort: "startDate",
      perPage: options?.perPage ?? 100,
    });
    const anchorDate = DateTime.makeUnsafe(anchor);
    const window = Duration.toMillis(
      windowLengthMs > 0 ? Duration.millis(windowLengthMs) : Duration.days(7),
    );
    const diffOrder = Order.mapInput(
      Order.Number,
      (entry: { event: Event; date: DateTime.DateTime; diff: number }) =>
        entry.diff,
    );

    const filtered = events
      .flatMap((event) => {
        const date = parseEventStartDate(event);
        if (!date) {
          return [];
        }
        return [
          {
            event,
            date,
            diff: Math.abs(DateTime.toEpochMillis(date) - DateTime.toEpochMillis(anchorDate)),
          },
        ];
      })
      .filter((entry) => entry.diff <= window)
      .sort((self, that) => diffOrder(self, that));

    const limited =
      typeof options?.limit === "number"
        ? filtered.slice(0, options.limit)
        : filtered;
    return limited.map((entry) => entry.event);
  });
