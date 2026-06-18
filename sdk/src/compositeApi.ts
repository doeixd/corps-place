import { Effect, Layer } from 'effect';

import { DciApi } from './service.js';
import type { DciError } from './errors.js';
import { makeDbBackedDciApi } from './dbBackedApi.js';
import { makeWebsiteScraperDciApi } from './websiteApi.js';
import { makeDciApi } from './client.js';
import { mergeConfig, type DciSdkConfigOverrides } from './config.js';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

/**
 * Create a composite DciApi that tries multiple sources in order.
 *
 * For each method:
 * 1. Primary source is queried first.
 * 2. If it returns empty AND is not an error, secondary is tried.
 * 3. If secondary returns empty, tertiary is tried.
 *
 * Network errors are silently swallowed so the pipeline continues.
 */
export const makeCompositeDciApi = (
  sources: [
    Effect.Effect<DciApi, DciError, SqlClient.SqlClient>,
    ...Effect.Effect<DciApi, DciError, SqlClient.SqlClient>[],
  ]
) =>
  Effect.gen(function* () {
    const apis = yield* (Effect.all(sources));
    const [primary, ...rest] = apis;

    const trySources = <A>(
      getter: (api: DciApi) => Effect.Effect<A, DciError, never>
    ): Effect.Effect<A, DciError, never> => {
      const attempt = (index: number): Effect.Effect<A, DciError, never> => {
        const api = apis[index];
        if (!api) return getter(primary);
        return getter(api).pipe(
          Effect.flatMap((result) => {
            if (Array.isArray(result) && result.length === 0) {
              return attempt(index + 1);
            }
            if (result && typeof result === 'object' && Object.keys(result).length === 0) {
              return attempt(index + 1);
            }
            return Effect.succeed(result);
          }),
          Effect.catch(() => attempt(index + 1))
        );
      };
      return attempt(0);
    };

    return DciApi.of({
      config: primary.config,
      getSeasons: () => trySources((api) => api.getSeasons()),
      getCompetitions: (season: string) => trySources((api) => api.getCompetitions(season)),
      listCompetitions: (query, options) =>
        trySources((api) => api.listCompetitions(query, options)),
      streamCompetitions: (query) => primary.streamCompetitions(query),
      getCompetitionRecap: (slug: string) => trySources((api) => api.getCompetitionRecap(slug)),
      getCorps: () => trySources((api) => api.getCorps()),
      getPerformanceClasses: () => trySources((api) => api.getPerformanceClasses()),
      getPerformanceCorps: (query) => trySources((api) => api.getPerformanceCorps(query)),
      getEventCorps: () => trySources((api) => api.getEventCorps()),
      getEventRegions: () => trySources((api) => api.getEventRegions()),
      getEventStates: () => trySources((api) => api.getEventStates()),
      listEvents: (query, options) => trySources((api) => api.listEvents(query, options)),
      streamEvents: (query) => primary.streamEvents(query),
      getCompetitionLocations: () => trySources((api) => api.getCompetitionLocations()),
      listGalleries: (query, options) => trySources((api) => api.listGalleries(query, options)),
      streamGalleries: (query) => primary.streamGalleries(query),
      listPerformances: (query, options) =>
        trySources((api) => api.listPerformances(query, options)),
      streamPerformances: (query) => primary.streamPerformances(query),
      getPageContent: () => trySources((api) => api.getPageContent()),
      getSponsors: () => trySources((api) => api.getSponsors()),
      getPastChampions: () => trySources((api) => api.getPastChampions()),
      rawPaginated: (path, schema) => primary.rawPaginated(path, schema),
      warmCache: (instructions) => primary.warmCache(instructions),
    });
  });

export interface CompositeApiOptions {
  readonly overrides?: DciSdkConfigOverrides;
  readonly sources?: ('db' | 'website' | 'network')[];
}

export const makeCompositeDciApiLayer = (options?: CompositeApiOptions) => {
  const sources = options?.sources ?? ['db', 'website', 'network'];
  const overrides = options?.overrides;

  const apiEffects: Effect.Effect<DciApi, DciError, SqlClient.SqlClient>[] = [];

  for (const source of sources) {
    switch (source) {
      case 'db':
        apiEffects.push(makeDbBackedDciApi(overrides));
        break;
      case 'website':
        apiEffects.push(makeWebsiteScraperDciApi({ overrides }));
        break;
      case 'network':
        apiEffects.push(makeDciApi(overrides));
        break;
    }
  }

  if (apiEffects.length === 0) {
    apiEffects.push(makeDbBackedDciApi(overrides));
  }

  return Layer.effect(
    DciApi,
    makeCompositeDciApi(
      apiEffects as [
        Effect.Effect<DciApi, DciError, SqlClient.SqlClient>,
        ...Effect.Effect<DciApi, DciError, SqlClient.SqlClient>[],
      ]
    )
  );
};

export const DciApiCompositeLive = makeCompositeDciApiLayer();
