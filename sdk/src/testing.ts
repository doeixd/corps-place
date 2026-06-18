import { Effect, Layer, Stream } from "effect";

import { mergeConfig, type DciSdkConfigOverrides } from "./config.js";
import { DciApi, WarmCacheInstruction } from "./service.js";
import type {
  Competition,
  Corps,
  CorpsScore,
  Event,
  Gallery,
  PageContentEntry,
  Season,
  Sponsor,
  PastChampion
} from "./domain.js";
import type { DciError } from "./errors.js";

const missing = (method: string) => Effect.die(`DciApiMock: ${method} not implemented`);
const emptyStream = <A>() =>
  Stream.fromIterable<A>([]) as unknown as Stream.Stream<A, DciError, never>;

export const makeDciApiMock = (overrides?: Partial<DciApi>, configOverrides?: DciSdkConfigOverrides): DciApi => {
  const config = mergeConfig(configOverrides);
  const base: DciApi = {
    config,
    getSeasons: () => missing("getSeasons"),
    getCompetitions: () => missing("getCompetitions"),
    listCompetitions: () => missing("listCompetitions"),
    streamCompetitions: () => emptyStream<Competition>(),
    getCompetitionRecap: () => missing("getCompetitionRecap"),
    getCorps: () => missing("getCorps"),
    getPerformanceClasses: () => missing("getPerformanceClasses"),
    getPerformanceCorps: () => missing("getPerformanceCorps"),
    getEventCorps: () => missing("getEventCorps"),
    getEventRegions: () => missing("getEventRegions"),
    getEventStates: () => missing("getEventStates"),
    listEvents: () => missing("listEvents"),
    streamEvents: () => emptyStream<Event>(),
    getCompetitionLocations: () => missing("getCompetitionLocations"),
    listGalleries: () => missing("listGalleries"),
    streamGalleries: () => emptyStream<Gallery>(),
    listPerformances: () => missing("listPerformances"),
    streamPerformances: () => emptyStream<CorpsScore>(),
    getPageContent: () => missing("getPageContent"),
    getSponsors: () => missing("getSponsors"),
    getPastChampions: () => missing("getPastChampions"),
    rawPaginated: () => missing("rawPaginated"),
    warmCache: (_instructions: WarmCacheInstruction[]) => Effect.void
  };

  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
    config: overrides.config ?? base.config
  };
};

export const makeDciApiMockLayer = (overrides?: Partial<DciApi>, configOverrides?: DciSdkConfigOverrides) =>
  Layer.succeed(DciApi, makeDciApiMock(overrides, configOverrides));

export interface DciApiFixtures {
  seasons?: ReadonlyArray<Season>;
  competitions?: Record<string, ReadonlyArray<Competition>>;
  competitionsList?: ReadonlyArray<Competition>;
  recaps?: Record<string, ReadonlyArray<CorpsScore>>;
  corps?: ReadonlyArray<Corps>;
  events?: ReadonlyArray<Event>;
  galleries?: ReadonlyArray<Gallery>;
  performances?: ReadonlyArray<CorpsScore>;
  performanceClasses?: ReadonlyArray<string>;
  performanceCorps?: ReadonlyArray<string>;
  eventCorps?: Record<string, string>;
  eventRegions?: ReadonlyArray<string>;
  eventStates?: ReadonlyArray<string>;
  competitionLocations?: ReadonlyArray<string>;
  pageContent?: ReadonlyArray<PageContentEntry>;
  sponsors?: ReadonlyArray<Sponsor>;
  pastChampions?: ReadonlyArray<PastChampion>;
}

export const makeFixtureDciApi = (fixtures: DciApiFixtures, configOverrides?: DciSdkConfigOverrides) => {
  const competitions = fixtures.competitions ?? {};
  const recaps = fixtures.recaps ?? {};
  const listCompetitions = fixtures.competitionsList ?? Object.values(competitions).flat();
  return makeDciApiMock(
    {
      getSeasons: () => Effect.succeed(fixtures.seasons ?? []),
      getCompetitions: (season: string) => Effect.succeed(competitions[season] ?? []),
      listCompetitions: () => Effect.succeed(listCompetitions),
      streamCompetitions: () =>
        Stream.fromIterable(listCompetitions) as unknown as Stream.Stream<Competition, DciError, never>,
      getCompetitionRecap: (slug: string) => Effect.succeed(recaps[slug] ?? []),
      getCorps: () => Effect.succeed(fixtures.corps ?? []),
      getPerformanceClasses: () => Effect.succeed(fixtures.performanceClasses ?? []),
      getPerformanceCorps: () => Effect.succeed(fixtures.performanceCorps ?? []),
      getEventCorps: () => Effect.succeed(fixtures.eventCorps ?? {}),
      getEventRegions: () => Effect.succeed(fixtures.eventRegions ?? []),
      getEventStates: () => Effect.succeed(fixtures.eventStates ?? []),
      listEvents: () => Effect.succeed(fixtures.events ?? []),
      streamEvents: () =>
        Stream.fromIterable(fixtures.events ?? []) as unknown as Stream.Stream<Event, DciError, never>,
      getCompetitionLocations: () => Effect.succeed(fixtures.competitionLocations ?? []),
      listGalleries: () => Effect.succeed(fixtures.galleries ?? []),
      streamGalleries: () =>
        Stream.fromIterable(fixtures.galleries ?? []) as unknown as Stream.Stream<Gallery, DciError, never>,
      listPerformances: () => Effect.succeed(fixtures.performances ?? []),
      streamPerformances: () =>
        Stream.fromIterable(fixtures.performances ?? []) as unknown as Stream.Stream<CorpsScore, DciError, never>,
      getPageContent: () => Effect.succeed(fixtures.pageContent ?? []),
      getSponsors: () => Effect.succeed(fixtures.sponsors ?? []),
      getPastChampions: () => Effect.succeed(fixtures.pastChampions ?? []),
      rawPaginated: () => Effect.succeed([]),
      warmCache: (_instructions: WarmCacheInstruction[]) => Effect.void
    },
    configOverrides
  );
};

export const makeFixtureDciApiLayer = (fixtures: DciApiFixtures, configOverrides?: DciSdkConfigOverrides) =>
  Layer.succeed(DciApi, makeFixtureDciApi(fixtures, configOverrides));
