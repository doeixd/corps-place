import { Deferred, Effect, Equal, Equivalence, Fiber, Hash, Queue, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { Competition } from "./domain.js";
import type { DciError } from "./errors.js";
import { DciApi, type WarmCacheInstruction } from "./service.js";
import { maybeRunWebsiteScrape, type WebsiteScrapeOptions } from "./websiteScraper.js";

interface SeasonJob {
  readonly _tag: "season";
  readonly season: string;
}

interface RecapJob {
  readonly _tag: "recap";
  readonly slug: string;
  readonly season: string;
}

interface WarmJob {
  readonly _tag: "warm";
  readonly instruction: WarmCacheInstruction;
}

type ScrapeJob = SeasonJob | RecapJob | WarmJob;

const jobKey = (job: ScrapeJob) => {
  switch (job._tag) {
    case "season":
      return `season:${job.season}`;
    case "recap":
      return `recap:${job.slug}`;
    case "warm":
      return `warm:${stableStringify(job.instruction)}`;
  }
};

const stableStringify = (input: unknown): string => {
  if (input === null || input === undefined) {
    return "null";
  }
  if (typeof input === "string") {
    return JSON.stringify(input);
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (input instanceof Date) {
    return JSON.stringify(input.toISOString());
  }
  if (Array.isArray(input)) {
    return `[${input.map(stableStringify).join(",")}]`;
  }
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => typeof value !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(input));
};

interface NormalizedScrapeOptions {
  readonly includeRecaps: boolean;
  readonly includeEvents: boolean;
  readonly includeGlobal: boolean;
  readonly includeGalleries: boolean;
  readonly includeWebsiteRecaps: boolean;
  readonly websiteRecapOptions?: WebsiteScrapeOptions;
  readonly warmInstructions: ReadonlyArray<WarmCacheInstruction>;
  readonly concurrency: number;
  readonly seasons: ReadonlyArray<string>;
}

export interface ScrapeOptions {
  readonly seasons?: ReadonlyArray<string>;
  readonly includeRecaps?: boolean;
  readonly includeEvents?: boolean;
  readonly includeGlobal?: boolean;
  readonly includeGalleries?: boolean;
  readonly includeWebsiteRecaps?: boolean;
  readonly websiteRecapOptions?: WebsiteScrapeOptions;
  readonly warmInstructions?: ReadonlyArray<WarmCacheInstruction>;
  readonly concurrency?: number;
}

export interface ScrapeStats {
  readonly seasons: ReadonlyArray<string>;
  readonly enqueued: number;
  readonly processed: number;
  readonly skipped: number;
}

const normalizeOptions = (seasons: ReadonlyArray<string>, options?: ScrapeOptions): NormalizedScrapeOptions => {
  const includeRecaps = options?.includeRecaps ?? true;
  const includeEvents = options?.includeEvents ?? true;
  const includeGlobal = options?.includeGlobal ?? true;
  const includeGalleries = options?.includeGalleries ?? true;
  const includeWebsiteRecaps = options?.includeWebsiteRecaps ?? false;
  const warmInstructions = options?.warmInstructions ?? [];
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 32));
  return {
    includeRecaps,
    includeEvents,
    includeGlobal,
    includeGalleries,
    includeWebsiteRecaps,
    websiteRecapOptions: options?.websiteRecapOptions,
    warmInstructions,
    concurrency,
    seasons
  };
};

const processSeason = (
  api: DciApi,
  season: string,
  options: NormalizedScrapeOptions,
  enqueueJob: (job: ScrapeJob) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const instructions: WarmCacheInstruction[] = [
      { namespace: "competitions", season }
    ];
    if (options.includeEvents) {
      instructions.push({
        namespace: "events",
        query: { season }
      });
    }
    yield* (api.warmCache(instructions));
    if (options.includeWebsiteRecaps) {
      yield* (
        maybeRunWebsiteScrape(season, options.websiteRecapOptions).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`[scrape] website recap ${season} failed: ${String(error)}`)
          )
        )
      );
    }
    if (!options.includeRecaps) {
      return;
    }
    const competitions = yield* (api.getCompetitions(season));
    const recapJobs = competitions.filter(hasRecapSlug).map((competition) => ({
      _tag: "recap" as const,
      slug: competition.slug,
      season
    }));
    yield* (Effect.forEach(recapJobs, enqueueJob));
  });

const hasRecapSlug = (competition: Competition): competition is Competition & { slug: string } =>
  competition.recapReleased && typeof competition.slug === "string" && competition.slug.length > 0;

interface RememberResult {
  readonly key: string;
  readonly enqueue: boolean;
}

export const scrapeAllData = (
  options?: ScrapeOptions
): Effect.Effect<ScrapeStats, DciError, DciApi | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const seasons = options?.seasons ?? (yield* (api.getSeasons()));
    const normalized = normalizeOptions(seasons, options);
    const queue = yield* (Queue.unbounded<ScrapeJob>());
    const pending = yield* (Ref.make(0));
    const enqueued = yield* (Ref.make(0));
    const processed = yield* (Ref.make(0));
    const skipped = yield* (Ref.make(0));
    const seen = yield* (Ref.make(new Map<number, ReadonlyArray<string>>()));
    const completed = yield* (Deferred.make<void>());

    const rememberJob = (job: ScrapeJob): Effect.Effect<RememberResult> =>
      Ref.modify(seen, (current) => {
        const key = jobKey(job);
        const hash = Hash.hash(key);
        const bucket = current.get(hash);
        if (bucket && bucket.some((entry) => Equivalence.String(entry, key) || Equal.equals(entry, key))) {
          return [{ key, enqueue: false } as RememberResult, current] as const;
        }
        const next = new Map(current);
        const updated = bucket ? [...bucket, key] : [key];
        next.set(hash, updated);
        return [{ key, enqueue: true } as RememberResult, next] as const;
      });

    const markComplete = Ref.updateAndGet(pending, (count) => Math.max(0, count - 1)).pipe(
      Effect.tap((count) => (count === 0 ? Deferred.succeed(completed, undefined) : Effect.void)),
      Effect.asVoid
    );

    const enqueueJob = (job: ScrapeJob): Effect.Effect<void> =>
      rememberJob(job).pipe(
        Effect.flatMap(({ key, enqueue }) => {
          if (!enqueue) {
            return Ref.update(skipped, (count) => count + 1).pipe(
              Effect.andThen(Effect.logDebug(`[scrape] skipped ${key}`))
            );
          }
          return Ref.updateAndGet(pending, (count) => count + 1).pipe(
            Effect.andThen(Ref.update(enqueued, (count) => count + 1)),
            Effect.andThen(Queue.offer(queue, job)),
            Effect.andThen(Effect.logDebug(`[scrape] queued ${key}`))
          );
        })
      );

    const runJob = (job: ScrapeJob) =>
      Effect.gen(function* () {
        const key = jobKey(job);
        yield* (Effect.logDebug(`[scrape] start ${key}`));
        switch (job._tag) {
          case "warm":
            yield* (api.warmCache([job.instruction]));
            break;
          case "season":
            yield* (processSeason(api, job.season, normalized, enqueueJob));
            break;
          case "recap":
            yield* (api.getCompetitionRecap(job.slug));
            break;
        }
        yield* (Ref.update(processed, (count) => count + 1));
        yield* (Effect.logDebug(`[scrape] finished ${key}`));
      }).pipe(
        Effect.withSpan("dci.scrape.job", { attributes: { job: jobKey(job) } })
      );

    const worker = Queue.take(queue).pipe(
      Effect.flatMap((job) =>
        runJob(job).pipe(
          Effect.catch((error) =>
            Effect.logError(`[scrape] job ${jobKey(job)} failed: ${error instanceof Error ? error.message : String(error)}`)
          ),
          Effect.ensuring(markComplete)
        )
      ),
      Effect.forever
    );

    const workers = yield* (
      Effect.forEach(Array.from({ length: normalized.concurrency }), () => Effect.forkChild(worker))
    );

    yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "seasons" } }));
    yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "corps" } }));

    if (normalized.includeGlobal) {
      yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "performanceClasses" } }));
      yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "sponsors" } }));
      yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "pastChampions" } }));
      yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "pageContent" } }));
    }

    if (normalized.includeGalleries) {
      yield* (enqueueJob({ _tag: "warm", instruction: { namespace: "galleries" } }));
    }

    for (const instruction of normalized.warmInstructions) {
      yield* (enqueueJob({ _tag: "warm", instruction }));
    }

    yield* (Effect.forEach(normalized.seasons, (season) => enqueueJob({ _tag: "season", season })));

    yield* (Deferred.await(completed));
    yield* (Queue.shutdown(queue));
    yield* (Effect.forEach(workers, Fiber.interrupt));

    const stats = yield* (
      Effect.all({
        enqueued: Ref.get(enqueued),
        processed: Ref.get(processed),
        skipped: Ref.get(skipped)
      })
    );

    return {
      seasons: normalized.seasons,
      enqueued: stats.enqueued,
      processed: stats.processed,
      skipped: stats.skipped
    };
  });
