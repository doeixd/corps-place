import { Context, Effect, Schema, Stream } from "effect";

import type { DciSdkConfig } from "./config.js";
import type {
  Competition,
  Corps,
  CorpsScore,
  Event,
  EventCorpsDictionary,
  Gallery,
  PageContentEntry,
  PastChampion,
  PerformanceClass,
  PerformanceCorpsList,
  Season,
  Sponsor
} from "./domain.js";
import type { DciError } from "./errors.js";

export type CachePrimeInstruction =
  | { namespace: "seasons" }
  | { namespace: "corps" }
  | { namespace: "competitions"; season: string }
  | { namespace: "recaps"; slug: string };

export type WarmCacheInstruction =
  | CachePrimeInstruction
  | { namespace: "performanceClasses" }
  | { namespace: "performanceCorps"; query?: PerformanceCorpsQuery }
  | { namespace: "eventCorps" }
  | { namespace: "eventRegions" }
  | { namespace: "eventStates" }
  | { namespace: "competitionLocations" }
  | { namespace: "pageContent" }
  | { namespace: "sponsors" }
  | { namespace: "pastChampions" }
  | { namespace: "events"; query?: EventsQuery; options?: PaginatedListOptions }
  | { namespace: "galleries"; query?: GalleriesQuery; options?: PaginatedListOptions }
  | { namespace: "performances"; query: PerformancesQuery; options?: PaginatedListOptions };

export type ComparisonOperator = ">" | "<" | ">=" | "<=" | "=";

export interface FilterExpression<T> {
  readonly op: ComparisonOperator;
  readonly value: T;
}

export type FilterValue<T> = T | FilterExpression<T>;

export interface PaginatedListOptions {
  readonly fetchAllPages?: boolean;
}

export interface CompetitionsQuery {
  readonly season?: string | number;
  readonly slug?: string;
  readonly region?: string;
  readonly state?: string;
  readonly location?: string;
  readonly division?: string;
  readonly class?: string;
  readonly sort?: string;
  readonly viewMode?: string;
  readonly search?: string;
  readonly startDate?: FilterValue<string | Date>;
  readonly endDate?: FilterValue<string | Date>;
  readonly limit?: number;
  readonly perPage?: number;
  readonly page?: number;
}

export interface EventsQuery {
  readonly season?: string | number;
  readonly corpId?: string;
  readonly region?: string;
  readonly state?: string;
  readonly viewMode?: string;
  readonly sort?: string;
  readonly startDate?: FilterValue<string | Date>;
  readonly endDate?: FilterValue<string | Date>;
  readonly search?: string;
  readonly limit?: number;
  readonly perPage?: number;
  readonly page?: number;
}

export interface GalleriesQuery {
  readonly corpId?: string;
  readonly tags?: ReadonlyArray<string> | string;
  readonly type?: number;
  readonly perPage?: number;
  readonly page?: number;
  readonly sort?: string;
}

export interface PerformancesQuery {
  readonly season?: string | number;
  readonly corp?: string;
  readonly class?: string;
  readonly division?: string;
  readonly slug?: string;
  readonly sort?: string;
  readonly startDate?: FilterValue<string | Date>;
  readonly endDate?: FilterValue<string | Date>;
  readonly perPage?: number;
  readonly page?: number;
}

export interface PerformanceCorpsQuery {
  readonly class?: string;
  readonly sort?: string;
}

export interface DciApi {
  readonly config: DciSdkConfig;
  readonly getSeasons: () => Effect.Effect<readonly Season[], DciError>;
  readonly getCompetitions: (season: string) => Effect.Effect<readonly Competition[], DciError>;
  readonly listCompetitions: (
    query?: CompetitionsQuery,
    options?: PaginatedListOptions
  ) => Effect.Effect<readonly Competition[], DciError>;
  readonly streamCompetitions: (query?: CompetitionsQuery) => Stream.Stream<Competition, DciError, never>;
  readonly getCompetitionRecap: (slug: string) => Effect.Effect<readonly CorpsScore[], DciError>;
  readonly getCorps: () => Effect.Effect<readonly Corps[], DciError>;
  readonly getPerformanceClasses: () => Effect.Effect<readonly PerformanceClass[], DciError>;
  readonly getPerformanceCorps: (query?: PerformanceCorpsQuery) => Effect.Effect<readonly string[], DciError>;
  readonly getEventCorps: () => Effect.Effect<EventCorpsDictionary, DciError>;
  readonly getEventRegions: () => Effect.Effect<readonly string[], DciError>;
  readonly getEventStates: () => Effect.Effect<readonly string[], DciError>;
  readonly listEvents: (
    query?: EventsQuery,
    options?: PaginatedListOptions
  ) => Effect.Effect<readonly Event[], DciError>;
  readonly streamEvents: (query?: EventsQuery) => Stream.Stream<Event, DciError, never>;
  readonly getCompetitionLocations: () => Effect.Effect<readonly string[], DciError>;
  readonly listGalleries: (
    query?: GalleriesQuery,
    options?: PaginatedListOptions
  ) => Effect.Effect<readonly Gallery[], DciError>;
  readonly streamGalleries: (query?: GalleriesQuery) => Stream.Stream<Gallery, DciError, never>;
  readonly listPerformances: (
    query: PerformancesQuery,
    options?: PaginatedListOptions
  ) => Effect.Effect<readonly CorpsScore[], DciError>;
  readonly streamPerformances: (query: PerformancesQuery) => Stream.Stream<CorpsScore, DciError, never>;
  readonly getPageContent: () => Effect.Effect<readonly PageContentEntry[], DciError>;
  readonly getSponsors: () => Effect.Effect<readonly Sponsor[], DciError>;
  readonly getPastChampions: () => Effect.Effect<readonly PastChampion[], DciError>;
  readonly rawPaginated: <A, I>(path: string, schema: Schema.Codec<A, I>) => Effect.Effect<readonly A[], DciError>;
  readonly warmCache: (instructions: WarmCacheInstruction[]) => Effect.Effect<void, DciError>;
}

export const DciApi = Context.Service<DciApi>("DciApi");
