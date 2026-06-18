import { SchemaParser } from "effect";
import { Cache, Chunk, Duration, Effect, Layer, Option, Schedule, Schema, Semaphore, Stream } from "effect";
import * as Redacted from "effect/Redacted";

import {
  DciApi,
  CachePrimeInstruction,
  CompetitionsQuery,
  EventsQuery,
  FilterExpression,
  FilterValue,
  GalleriesQuery,
  PaginatedListOptions,
  PerformanceCorpsQuery,
  PerformancesQuery,
  WarmCacheInstruction
} from "./service.js";
import {
  mergeConfig,
  resolveCacheSettings,
  type CacheNamespace,
  type DciSdkConfig,
  type DciSdkConfigOverrides
} from "./config.js";
import * as Domain from "./domain.js";
import { DciDecodeError, DciHttpError, DciNetworkError, type DciError } from "./errors.js";
import { makeCacheService as makeMemoryCacheService, type CacheProviders } from "./cache.js";
import { makeSqliteCacheService, makeLibsqlCacheLayer } from "./cacheSqlite.js";
import { DciObservability, DciObservabilityNoop } from "./observability.js";
import { DciRequestSupervisor } from "./requestSupervisor.js";

const paginationHeader = (response: Response, name: string) => {
  return response.headers.get(name) ?? response.headers.get(name.toLowerCase()) ?? response.headers.get(name.toUpperCase()) ?? undefined;
};

const appendPageParam = (path: string, page: number) => {
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}page=${page}`;
};

const makeDecodeError = (path: string, cause: unknown) =>
  new DciDecodeError({
    message: `Unable to decode response for ${path}`,
    path,
    issues: cause
  });

const buildRetrySchedule = (retry: DciSdkConfig["retry"]) => {
  const base = Schedule.exponential(Duration.millis(retry.initialDelayMs)).pipe(
    Schedule.both(Schedule.recurs(retry.attempts))
  );

  return retry.jitter ? base.pipe(Schedule.jittered) : base;
};

const normalizePath = (baseUrl: string, path: string) => {
  if (path.startsWith("http")) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
};

type PrimitiveQueryValue = string | number | boolean | Date;
type QueryParam = PrimitiveQueryValue | FilterValue<string | number | Date>;
type QueryParams = Record<string, QueryParam | ReadonlyArray<QueryParam> | undefined>;

const queryKeyMap: Record<string, string> = {
  perPage: "per-page"
};

const isFilter = (value: unknown): value is FilterExpression<string | number | Date> =>
  typeof value === "object" && value !== null && "op" in (value as Record<string, unknown>) && "value" in (value as Record<string, unknown>);

const formatDateOnly = (value: Date | string) => {
  if (value instanceof Date) {
    return value.toISOString().split("T")[0]!;
  }
  return value;
};

const formatPrimitive = (value: PrimitiveQueryValue) => {
  if (value instanceof Date) {
    return formatDateOnly(value);
  }
  return String(value);
};

const serializeQueryValue = (value: QueryParam) => {
  if (isFilter(value)) {
    return `${value.op}${formatPrimitive(value.value as PrimitiveQueryValue)}`;
  }
  return formatPrimitive(value as PrimitiveQueryValue);
};

const encodeQuery = (params?: QueryParams) => {
  if (!params) {
    return "";
  }
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null) as [string, QueryParam | ReadonlyArray<QueryParam>][];
  if (entries.length === 0) {
    return "";
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = new URLSearchParams();
  for (const [key, rawValue] of entries) {
    const mappedKey = queryKeyMap[key] ?? key;
    if (isQueryArray(rawValue)) {
      rawValue.forEach((item) => search.append(mappedKey, serializeQueryValue(item)));
    } else {
      search.append(mappedKey, serializeQueryValue(rawValue));
    }
  }
  return search.toString();
};

const buildPath = (basePath: string, params?: QueryParams) => {
  const query = encodeQuery(params);
  return query ? `${basePath}?${query}` : basePath;
};

const buildCompetitionsPath = (query?: CompetitionsQuery) =>
  buildPath("/competitions", {
    season: query?.season,
    slug: query?.slug,
    region: query?.region,
    state: query?.state,
    location: query?.location,
    division: query?.division,
    class: query?.class,
    sort: query?.sort,
    viewMode: query?.viewMode,
    search: query?.search,
    startDate: query?.startDate,
    endDate: query?.endDate,
    limit: query?.limit,
    perPage: query?.perPage,
    page: query?.page
  });

const shouldFetchAllPages = (options: PaginatedListOptions | undefined, page?: number) =>
  options?.fetchAllPages ?? (page === undefined);

const ensureArray = <T>(value?: ReadonlyArray<T> | T): ReadonlyArray<T> | undefined => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value as ReadonlyArray<T>;
  }
  return [value as T];
};

const isQueryArray = (value: QueryParam | ReadonlyArray<QueryParam>): value is ReadonlyArray<QueryParam> =>
  Array.isArray(value);

const buildEventsPath = (query?: EventsQuery) =>
  buildPath("/events", {
    season: query?.season,
    corpId: query?.corpId,
    region: query?.region,
    state: query?.state,
    viewMode: query?.viewMode,
    sort: query?.sort,
    startDate: query?.startDate,
    endDate: query?.endDate,
    search: query?.search,
    limit: query?.limit,
    perPage: query?.perPage,
    page: query?.page
  });

const buildGalleriesPath = (query?: GalleriesQuery) =>
  buildPath("/galleries", {
    corpId: query?.corpId,
    tags: ensureArray(query?.tags),
    type: query?.type,
    perPage: query?.perPage,
    page: query?.page,
    sort: query?.sort
  });

const buildPerformancesPath = (query: PerformancesQuery) =>
  buildPath("/performances", {
    season: query.season,
    corp: query.corp,
    class: query.class,
    division: query.division,
    slug: query.slug,
    sort: query.sort,
    startDate: query.startDate,
    endDate: query.endDate,
    perPage: query.perPage,
    page: query.page
  });

const buildPerformanceCorpsPath = (query?: PerformanceCorpsQuery) =>
  buildPath("/performances/corps", {
    class: query?.class,
    sort: query?.sort
  });

const SINGLETON_CACHE_KEY = "__singleton__" as const;
const withPage = <Q extends { page?: number }>(query: Q | undefined, page: number): Q =>
  ({
    ...(query ?? {}),
    page
  }) as Q;

export const makeDciApi = (overrides?: DciSdkConfigOverrides) =>
  Effect.gen(function* () {
    const config = mergeConfig(overrides);
    const rateLimiter = yield* (Semaphore.make(config.rateLimit.maxConcurrent));
    const observabilityService = yield* (Effect.serviceOption(DciObservability));
    const requestSupervisorService = yield* (Effect.serviceOption(DciRequestSupervisor));
    const observability = Option.match(observabilityService, {
      onNone: () => DciObservabilityNoop,
      onSome: (service) => service
    });
    const trackWithSupervisor = Option.match(requestSupervisorService, {
      onNone: () => <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      onSome: (service) => service.track
    });

    const buildRequest = (path: string) => {
      const url = normalizePath(config.baseUrl, path);
      const clientFetch = globalThis.fetch;
      if (typeof clientFetch !== "function") {
        return Effect.fail(
          new DciNetworkError({
            message: "Global fetch is unavailable in this runtime",
            statusCode: 0
          })
        );
      }

      return Effect.tryPromise((abortSignal) =>
        clientFetch(url, {
          signal: abortSignal,
          headers: {
            accept: "application/json",
            "user-agent": config.userAgent
          }
        })
      ).pipe(
        Effect.mapError((error) =>
          new DciNetworkError({
            message: String(error),
            statusCode: 0,
            cause: error
          })
        ),
        Effect.flatMap((response) =>
          response.ok
            ? Effect.succeed(response)
            : Effect.fail(
              new DciHttpError({
                message: response.statusText ?? `HTTP ${response.status}`,
                statusCode: response.status,
                path
              })
            )
        )
      );
    };

    const send = (path: string) => {
      const request = buildRequest(path);
      const logged = config.logRequests
        ? request.pipe(Effect.tap((response) => Effect.log(`DCI ${path} -> ${response.status}`)))
        : request;

      const performRequest = Effect.gen(function* () {
        const startedAt = Date.now();
        yield* (observability.requestStart(path));
        return yield* (
          logged.pipe(
            Effect.tap((response) =>
              observability.requestSuccess(path, response.status, Date.now() - startedAt)
            ),
            Effect.tapError((error: DciError) =>
              observability.requestFailure(path, error, Date.now() - startedAt)
            )
          )
        );
      }).pipe(
        Effect.retry(buildRetrySchedule(config.retry)),
        Effect.withSpan("dci.http", { attributes: { path } })
      );

      return rateLimiter.withPermits(1)(trackWithSupervisor(performRequest));
    };

    const decodeResponse = <A, I>(path: string, response: Response, schema: Schema.Codec<A, I>) =>
      Effect.tryPromise(() => response.text()).pipe(
        Effect.mapError((cause) => makeDecodeError(path, cause)),
        Effect.tap((text) =>
          config.onResponse
            ? config.onResponse(response.url, text).pipe(Effect.catch(() => Effect.void))
            : Effect.void
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text),
            catch: (cause) => makeDecodeError(path, cause),
          })
        ),
        Effect.flatMap((body) =>
          SchemaParser.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError((cause) => makeDecodeError(path, cause))
          )
        )
      );

    const decodePage = <A, I>(path: string, response: Response, schema: Schema.Codec<A, I>) =>
      decodeResponse(path, response, Schema.Array(schema));

    const fetchPaginated = <A, I>(path: string, schema: Schema.Codec<A, I>, options?: { fetchAll?: boolean }) =>
      Effect.gen(function* () {
        const response = yield* (send(path));
        const totalPages = Number(paginationHeader(response, "x-pagination-page-count") ?? "1");
        const firstPage = yield* (decodePage(path, response, schema));
        if (totalPages > 1) {
          yield* (observability.pagination(path, 1, totalPages));
        }

        const fetchAll = options?.fetchAll ?? true;

        if (!fetchAll || totalPages <= 1) {
          return firstPage;
        }

        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
        const restPages = yield* (
          Effect.all(
            pageNumbers.map((page) =>
              Effect.gen(function* () {
                const pagedPath = appendPageParam(path, page);
                const res = yield* (send(pagedPath));
                const body = yield* (decodePage(pagedPath, res, schema));
                if (totalPages > 1) {
                  yield* (observability.pagination(pagedPath, page, totalPages));
                }
                return body;
              })
            ),
            { concurrency: config.paginationConcurrency }
          )
        );

        return [...firstPage, ...restPages.flat()];
      }).pipe(Effect.withSpan("dci.fetch", { attributes: { path } }));

    const fetchJson = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        const response = yield* (send(path));
        return yield* (decodeResponse(path, response, schema));
      });

    const streamPaginated = <A, I>(
      initialPage: number,
      pathBuilder: (page: number) => string,
      schema: Schema.Codec<A, I>
    ): Stream.Stream<A, DciError, never> => {
      let totalPages: number | undefined;
      const fetchPage = (page: number) =>
        Effect.gen(function* () {
          const path = pathBuilder(page);
          const response = yield* (send(path));
          if (totalPages === undefined) {
            totalPages = Number(paginationHeader(response, "x-pagination-page-count") ?? "1");
          }
          const body = yield* (decodePage(path, response, schema));
          if (totalPages > 1) {
            yield* (observability.pagination(path, page, totalPages));
          }
          return {
            items: body,
            hasMore: totalPages ? page < totalPages : body.length > 0
          };
        });

      // v4 has no chunk-wise unfold; Stream.paginate emits an array of items per
      // step and continues while the returned Option is Some (faithful to the old
      // unfoldChunkEffect: empty page after the first stops the stream).
      return Stream.paginate(
        initialPage,
        (page: number): Effect.Effect<readonly [readonly A[], Option.Option<number>], DciError> =>
          fetchPage(page).pipe(
            Effect.map(({ items, hasMore }) => {
              const stop = items.length === 0 && page !== initialPage;
              const next = !stop && hasMore ? Option.some(page + 1) : Option.none<number>();
              return [items, next] as const;
            })
          )
      );
    };

    const cacheProviders: CacheProviders = {
      seasons: () => fetchPaginated("/competitions/seasons", Domain.SeasonSchema),
      corps: () => fetchPaginated("/corps", Domain.CorpsSchema),
      competitions: (season: string) =>
        fetchPaginated(`/competitions?season=${encodeURIComponent(season)}`, Domain.CompetitionSchema),
      recaps: (slug: string) => fetchPaginated(`/competitions/${slug}`, Domain.CorpsScoreSchema)
    };

    const cacheService = yield* (
      config.cache.mode === "sqlite"
        ? config.cache.sqlite?.url
          ? makeSqliteCacheService(config, cacheProviders, observability).pipe(
            Effect.provide(
              makeLibsqlCacheLayer({
                url: config.cache.sqlite.url,
                authToken: config.cache.sqlite.authToken
                  ? Redacted.make(config.cache.sqlite.authToken)
                  : undefined,
                table: config.cache.sqlite.table
              })
            )
          )
          : Effect.fail(
            new DciDecodeError({
              message: "SQLite cache mode requires cache.sqlite.url to be set",
              path: "cache.sqlite",
              issues: undefined
            })
          )
        : makeMemoryCacheService(config, cacheProviders, observability)
    );

    const makeSingletonCache = <Value>(
      namespace: CacheNamespace,
      loader: () => Effect.Effect<Value, DciError>
    ) =>
      Effect.gen(function* () {
        const settings = resolveCacheSettings(config.cache, namespace);
        const lookupKey = SINGLETON_CACHE_KEY;
        const loadWithTelemetry = () =>
          loader().pipe(Effect.tap(() => observability.cachePopulate(namespace, lookupKey)));
        if (!settings.enabled) {
          return () =>
            observability.cacheLookup(namespace, lookupKey).pipe(
              Effect.andThen(loadWithTelemetry())
            );
        }
        const cache = yield* (
          Cache.make<string, Value, DciError>({
            capacity: settings.capacity,
            timeToLive: Duration.millis(settings.ttlMs),
            lookup: () => loadWithTelemetry()
          })
        );
        return () =>
          observability.cacheLookup(namespace, lookupKey).pipe(Effect.andThen(Cache.get(cache, SINGLETON_CACHE_KEY)));
      });

    const makeKeyedCache = <Value>(
      namespace: CacheNamespace,
      loader: (key: string) => Effect.Effect<Value, DciError>
    ) =>
      Effect.gen(function* () {
        const settings = resolveCacheSettings(config.cache, namespace);
        const loadWithTelemetry = (key: string) =>
          loader(key).pipe(Effect.tap(() => observability.cachePopulate(namespace, key)));
        if (!settings.enabled) {
          return (key: string) =>
            observability.cacheLookup(namespace, key).pipe(
              Effect.andThen(loadWithTelemetry(key))
            );
        }
        const cache = yield* (
          Cache.make<string, Value, DciError>({
            capacity: settings.capacity,
            timeToLive: Duration.millis(settings.ttlMs),
            lookup: (key: string) => loadWithTelemetry(key)
          })
        );
        return (key: string) =>
          observability.cacheLookup(namespace, key).pipe(Effect.andThen(Cache.get(cache, key)));
      });

    const performanceClassesCache = yield* (
      makeSingletonCache("performanceClasses", () =>
        fetchJson("/performances/classes", Schema.Array(Domain.PerformanceClassSchema))
      )
    );

    const eventCorpsCache = yield* (
      makeSingletonCache("eventCorps", () =>
        fetchJson("/events/corps?sort=name", Domain.EventCorpsDictionarySchema)
      )
    );

    const eventRegionsCache = yield* (
      makeSingletonCache("eventRegions", () => fetchJson("/events/regions", Schema.Array(Schema.String)))
    );

    const eventStatesCache = yield* (
      makeSingletonCache("eventStates", () => fetchJson("/events/states", Schema.Array(Schema.String)))
    );

    const competitionLocationsCache = yield* (
      makeSingletonCache("competitionLocations", () =>
        fetchJson("/competitions/locations", Schema.Array(Schema.String))
      )
    );

    const pageContentCache = yield* (
      makeSingletonCache("pageContent", () => fetchJson("/page-content", Schema.Array(Domain.PageContentEntrySchema)))
    );

    const sponsorsCache = yield* (
      makeSingletonCache("sponsors", () => fetchJson("/sponsors", Schema.Array(Domain.SponsorSchema)))
    );

    const pastChampionsCache = yield* (
      makeSingletonCache("pastChampions", () => fetchJson("/past-champions", Schema.Array(Domain.PastChampionSchema)))
    );

    const performanceCorpsCache = yield* (
      makeKeyedCache("performanceCorps", (path) => fetchJson(path, Domain.PerformanceCorpsListSchema))
    );

    const isCoreInstruction = (instruction: WarmCacheInstruction): instruction is CachePrimeInstruction => {
      switch (instruction.namespace) {
        case "seasons":
        case "corps":
        case "competitions":
        case "recaps":
          return true;
        default:
          return false;
      }
    };

    const warmExtendedInstruction = (instruction: WarmCacheInstruction) => {
      switch (instruction.namespace) {
        case "performanceClasses":
          return performanceClassesCache().pipe(Effect.asVoid);
        case "performanceCorps":
          return getPerformanceCorpsEffect(instruction.query).pipe(Effect.asVoid);
        case "eventCorps":
          return eventCorpsCache().pipe(Effect.asVoid);
        case "eventRegions":
          return eventRegionsCache().pipe(Effect.asVoid);
        case "eventStates":
          return eventStatesCache().pipe(Effect.asVoid);
        case "competitionLocations":
          return competitionLocationsCache().pipe(Effect.asVoid);
        case "pageContent":
          return pageContentCache().pipe(Effect.asVoid);
        case "sponsors":
          return sponsorsCache().pipe(Effect.asVoid);
        case "pastChampions":
          return pastChampionsCache().pipe(Effect.asVoid);
        case "events":
          return listEventsEffect(instruction.query, instruction.options).pipe(Effect.asVoid);
        case "galleries":
          return listGalleriesEffect(instruction.query, instruction.options).pipe(Effect.asVoid);
        case "performances":
          return listPerformancesEffect(instruction.query, instruction.options).pipe(Effect.asVoid);
        default:
          return Effect.void;
      }
    };

    const warmCache = (instructions: WarmCacheInstruction[]) => {
      const core: CachePrimeInstruction[] = [];
      const extended: WarmCacheInstruction[] = [];

      for (const instruction of instructions) {
        if (isCoreInstruction(instruction)) {
          core.push(instruction);
        } else {
          extended.push(instruction);
        }
      }

      const warmCore = core.length > 0 ? cacheService.warm(core) : Effect.void;
      const warmExtended =
        extended.length > 0
          ? Effect.forEach(extended, warmExtendedInstruction, { concurrency: config.paginationConcurrency }).pipe(
            Effect.asVoid
          )
          : Effect.void;

      return warmCore.pipe(Effect.andThen(warmExtended));
    };

    const listCompetitionsEffect = (query?: CompetitionsQuery, options?: PaginatedListOptions) => {
      const path = buildCompetitionsPath(query);
      const fetchAll = shouldFetchAllPages(options, query?.page);
      return fetchPaginated(path, Domain.CompetitionSchema, { fetchAll });
    };

    const streamCompetitionsEffect = (query?: CompetitionsQuery) => {
      const startPage = query?.page ?? 1;
      return streamPaginated(startPage, (page) => buildCompetitionsPath(withPage(query, page)), Domain.CompetitionSchema);
    };

    const listEventsEffect = (query?: EventsQuery, options?: PaginatedListOptions) => {
      const path = buildEventsPath(query);
      const fetchAll = shouldFetchAllPages(options, query?.page);
      return fetchPaginated(path, Domain.EventSchema, { fetchAll });
    };

    const streamEventsEffect = (query?: EventsQuery) => {
      const startPage = query?.page ?? 1;
      return streamPaginated(startPage, (page) => buildEventsPath(withPage(query, page)), Domain.EventSchema);
    };

    const listGalleriesEffect = (query?: GalleriesQuery, options?: PaginatedListOptions) => {
      const path = buildGalleriesPath(query);
      const fetchAll = shouldFetchAllPages(options, query?.page);
      return fetchPaginated(path, Domain.GallerySchema, { fetchAll }).pipe(
        Effect.map((entries) => Domain.normalizeGalleries(entries))
      );
    };

    const streamGalleriesEffect = (query?: GalleriesQuery) => {
      const startPage = query?.page ?? 1;
      return streamPaginated(startPage, (page) => buildGalleriesPath(withPage(query, page)), Domain.GallerySchema).pipe(
        Stream.map(Domain.normalizeGallery)
      );
    };

    const listPerformancesEffect = (query: PerformancesQuery, options?: PaginatedListOptions) => {
      const path = buildPerformancesPath(query);
      const fetchAll = shouldFetchAllPages(options, query.page);
      return fetchPaginated(path, Domain.CorpsScoreSchema, { fetchAll });
    };

    const streamPerformancesEffect = (query: PerformancesQuery) => {
      const startPage = query.page ?? 1;
      return streamPaginated(startPage, (page) => buildPerformancesPath(withPage(query, page)), Domain.CorpsScoreSchema);
    };

    const getPerformanceCorpsEffect = (query?: PerformanceCorpsQuery) => {
      const path = buildPerformanceCorpsPath(query);
      return performanceCorpsCache(path);
    };

    return DciApi.of({
      config,
      getSeasons: () => cacheService.getSeasons(),
      getCompetitions: (season: string) => cacheService.getCompetitions(season),
      listCompetitions: (query?: CompetitionsQuery, options?: PaginatedListOptions) =>
        listCompetitionsEffect(query, options),
      streamCompetitions: (query?: CompetitionsQuery) => streamCompetitionsEffect(query),
      getCompetitionRecap: (slug: string) => cacheService.getCompetitionRecap(slug),
      getCorps: () => cacheService.getCorps(),
      getPerformanceClasses: () => performanceClassesCache(),
      getPerformanceCorps: (query?: PerformanceCorpsQuery) => getPerformanceCorpsEffect(query),
      getEventCorps: () => eventCorpsCache(),
      getEventRegions: () => eventRegionsCache(),
      getEventStates: () => eventStatesCache(),
      listEvents: (query?: EventsQuery, options?: PaginatedListOptions) => listEventsEffect(query, options),
      streamEvents: (query?: EventsQuery) => streamEventsEffect(query),
      getCompetitionLocations: () => competitionLocationsCache(),
      listGalleries: (query?: GalleriesQuery, options?: PaginatedListOptions) => listGalleriesEffect(query, options),
      streamGalleries: (query?: GalleriesQuery) => streamGalleriesEffect(query),
      listPerformances: (query: PerformancesQuery, options?: PaginatedListOptions) =>
        listPerformancesEffect(query, options),
      streamPerformances: (query: PerformancesQuery) => streamPerformancesEffect(query),
      getPageContent: () => pageContentCache(),
      getSponsors: () => sponsorsCache(),
      getPastChampions: () => pastChampionsCache(),
      rawPaginated: (path, schema) => fetchPaginated(path, schema),
      warmCache
    });
  });

export const makeDciApiLayer = (overrides?: DciSdkConfigOverrides) =>
  Layer.effect(DciApi, makeDciApi(overrides));

export const DciApiLive = makeDciApiLayer();
