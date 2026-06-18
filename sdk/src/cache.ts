import { Cache, Context, Duration, Effect, Layer } from "effect";

import { resolveCacheSettings, type CacheNamespace, type DciSdkConfig } from "./config.js";
import * as Domain from "./domain.js";
import type { CachePrimeInstruction } from "./service.js";
import type { DciError } from "./errors.js";
import { DciObservability, DciObservabilityNoop } from "./observability.js";

export const seasonsCacheKey = "__seasons__" as const;
export const corpsCacheKey = "__corps__" as const;

export type CacheLookup<Key, Value> = (key: Key) => Effect.Effect<readonly Value[], DciError>;

export interface CacheProviders {
  seasons: CacheLookup<typeof seasonsCacheKey, Domain.Season>;
  corps: CacheLookup<typeof corpsCacheKey, Domain.Corps>;
  competitions: CacheLookup<string, Domain.Competition>;
  recaps: CacheLookup<string, Domain.CorpsScore>;
}

type NamespaceCacheState<Key, Value> =
  | {
      readonly mode: "cached";
      readonly namespace: CacheNamespace;
      readonly cache: Cache.Cache<Key, readonly Value[], DciError>;
    }
  | {
      readonly mode: "passthrough";
      readonly namespace: CacheNamespace;
      readonly lookup: CacheLookup<Key, Value>;
    };

export interface CacheService {
  readonly getSeasons: () => Effect.Effect<readonly Domain.Season[], DciError>;
  readonly getCorps: () => Effect.Effect<readonly Domain.Corps[], DciError>;
  readonly getCompetitions: (season: string) => Effect.Effect<readonly Domain.Competition[], DciError>;
  readonly getCompetitionRecap: (slug: string) => Effect.Effect<readonly Domain.CorpsScore[], DciError>;
  readonly warm: (instructions: CachePrimeInstruction[]) => Effect.Effect<void, DciError>;
}

export const CacheService = Context.Service<CacheService>("CacheService");

const buildEntry = <Key extends string, Value>(
  config: DciSdkConfig,
  namespace: CacheNamespace,
  lookup: CacheLookup<Key, Value>,
  observability: DciObservability
) =>
  Effect.gen(function* () {
    const settings = resolveCacheSettings(config.cache, namespace);
    const populate = (key: Key) =>
      lookup(key).pipe(
        Effect.tap(() => observability.cachePopulate(namespace, key))
      );

    if (!settings.enabled) {
      return {
        mode: "passthrough" as const,
        namespace,
        lookup: (key: Key) => populate(key)
      };
    }

    const cache = yield* (
      Cache.make<Key, readonly Value[], DciError>({
        capacity: settings.capacity,
        timeToLive: Duration.millis(settings.ttlMs),
        lookup: (key: Key) => populate(key)
      })
    );

    return {
      mode: "cached" as const,
      namespace,
      cache
    };
  });

const readCache = <Key extends string, Value>(
  entry: NamespaceCacheState<Key, Value>,
  key: Key,
  observability: DciObservability
) =>
  observability.cacheLookup(entry.namespace, key).pipe(
    Effect.flatMap(() =>
      entry.mode === "cached"
        ? // v3 getEither (Left = already-cached hit, Right = freshly computed miss)
          // has no v4 equivalent: getOption tells us presence without computing,
          // then get returns the value (computing on miss).
          Cache.getOption(entry.cache, key).pipe(
            Effect.tap((option) =>
              option._tag === "Some"
                ? observability.cacheHit(entry.namespace, key)
                : observability.cacheMiss(entry.namespace, key)
            ),
            Effect.flatMap((option) =>
              option._tag === "Some" ? Effect.succeed(option.value) : Cache.get(entry.cache, key)
            )
          )
        : entry.lookup(key).pipe(
            Effect.tap(() => observability.cacheMiss(entry.namespace, key))
          )
    )
  );

export const makeMemoryCacheService = (
  config: DciSdkConfig,
  providers: CacheProviders,
  observability: DciObservability = DciObservabilityNoop
) =>
  Effect.gen(function* () {
    const entries = yield* (
      Effect.all({
        seasons: buildEntry(config, "seasons", providers.seasons, observability),
        corps: buildEntry(config, "corps", providers.corps, observability),
        competitions: buildEntry(config, "competitions", providers.competitions, observability),
        recaps: buildEntry(config, "recaps", providers.recaps, observability)
      })
    );

    const warm = (instructions: CachePrimeInstruction[]) =>
      Effect.all(
        instructions.map((instruction) => {
          switch (instruction.namespace) {
            case "seasons":
              return readCache(entries.seasons, seasonsCacheKey, observability).pipe(Effect.asVoid);
            case "corps":
              return readCache(entries.corps, corpsCacheKey, observability).pipe(Effect.asVoid);
            case "competitions":
              return readCache(entries.competitions, instruction.season, observability).pipe(Effect.asVoid);
            case "recaps":
              return readCache(entries.recaps, instruction.slug, observability).pipe(Effect.asVoid);
          }
        }),
        { concurrency: 2 }
      ).pipe(Effect.asVoid);

    return {
      getSeasons: () => readCache(entries.seasons, seasonsCacheKey, observability),
      getCorps: () => readCache(entries.corps, corpsCacheKey, observability),
      getCompetitions: (season: string) => readCache(entries.competitions, season, observability),
      getCompetitionRecap: (slug: string) => readCache(entries.recaps, slug, observability),
      warm
    };
  });

export const makeCacheService = makeMemoryCacheService;

export const makeCacheLayer = (
  config: DciSdkConfig,
  providers: CacheProviders,
  observability?: DciObservability
) => Layer.effect(CacheService, makeMemoryCacheService(config, providers, observability));
