import { createServerFn } from '@tanstack/react-start/client';
import { Effect } from 'effect';
import {
  EventDirectoryService,
  EventDirectoryServiceLive,
  type EventSeasonOption,
} from '@/lib/event-directory';
import {
  EventPredictionService,
  EventPredictionServiceLive,
  type EventPredictionRequest,
} from '@/lib/event-prediction-api';
import { EventRecapService, EventRecapServiceLive } from '@/lib/event-recap';
import {
  CorpsDirectoryService,
  CorpsDirectoryServiceLive,
  type CorpsSummary,
} from '@/lib/corps-directory';
import { JudgeDirectoryService, JudgeDirectoryServiceLive } from '@/lib/judge-directory';
import { StaffDirectoryService, StaffDirectoryServiceLive } from '@/lib/staff-directory';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import {
  buildShowInfoForSeason,
  buildShowDetail,
  type ShowInfoSummary,
  type ShowDetail,
} from '@sdk/src/readModel/builders/shows.js';
import { MerchDirectoryService, MerchDirectoryServiceLive } from '@/lib/merch-directory';
import { readShowInfoForSeason, readShowDetail } from '@sdk/src/readModel/readers.js';
import { createClient } from '@libsql/client';
import * as path from 'node:path';

/**
 * Hybrid validation server functions (transition implementation).
 *
 * Goal: All business logic lives in Effect.Services (with Effect.fn).
 * For now we provide the Service.Defaults explicitly at the createServerFn boundary
 * (same pattern as the existing server-fns).
 * Once we have a real RPC client transport or fix the layer composition for direct service access,
 * these will switch to pure provideApp(AppRpcLive) style.
 *
 * See MIGRATION_PLAN.md "State Management with XState + Effect" and Phase 1 for the target architecture.
 */

const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(EventDirectoryServiceLive),
    Effect.provide(EventPredictionServiceLive),
    Effect.provide(EventRecapServiceLive),
    Effect.provide(CorpsDirectoryServiceLive),
    Effect.provide(JudgeDirectoryServiceLive),
    Effect.provide(StaffDirectoryServiceLive),
    Effect.provide(MerchDirectoryServiceLive)
  );

// The corps directory changes only when new lineup/corps data is ingested (rare),
// so a generous TTL keeps the ~300ms query off the navigation path almost always.
// Worst case after an ingest: the directory is up to this stale.
const CORPS_DIRECTORY_CACHE_MS = 10 * 60_000;
const SEASON_OPTIONS_CACHE_MS = 5 * 60_000;
let corpsDirectoryCache: { expiresAt: number; value: CorpsSummary[] } | null = null;
const eventSeasonOptionsCache = new Map<
  string,
  { expiresAt: number; value: EventSeasonOption[] }
>();

const uniqueStrings = (values: readonly unknown[]) =>
  Array.from(
    new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );

type EventPredictionPageData = {
  prediction: any | null;
  event: any | null;
  schedule: any[];
  corps: CorpsSummary[];
  recap: { meta: any | null; scores: any[] } | null;
  seasonOptions: EventSeasonOption[];
  showTitles: Record<string, string>;
  showInfo: Record<string, ShowInfoSummary>;
};

const cachedEventSeasonOptions = (slug: string) =>
  Effect.suspend(() => {
    const cached = eventSeasonOptionsCache.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return Effect.succeed(cached.value);
    }
    return Effect.flatMap(EventDirectoryService, (s) => s.eventSeasonOptions(slug)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          eventSeasonOptionsCache.set(slug, {
            expiresAt: Date.now() + SEASON_OPTIONS_CACHE_MS,
            value,
          });
        })
      )
    );
  });

// Show titles for a season (corps_key → program title). Reads the precomputed
// rm_show_titles when READ_MODEL_DB_URL is set, else the big-DB corps_shows
// table via the shared builder. One definition each side (READ_MODEL_PLAN §8).
let _showTitlesBigDb: ReturnType<typeof createClient> | null = null;
const getShowTitlesBigDb = () => {
  if (!_showTitlesBigDb) {
    const sdkDir = path.resolve(process.cwd(), 'sdk');
    const dbUrl =
      process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir, 'dci-relational.db')}`;
    _showTitlesBigDb = createClient({ url: dbUrl });
  }
  return _showTitlesBigDb;
};

const SHOW_TITLES_CACHE_MS = 5 * 60_000;

const showInfoCache = new Map<
  string,
  { expiresAt: number; value: Record<string, ShowInfoSummary> }
>();

const getShowInfoForSeason = Effect.fn('getShowInfoForSeason')(function* (season: string) {
  const cached = showInfoCache.get(season);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const info = yield* Effect.tryPromise({
    try: () =>
      readModelEnabled()
        ? readShowInfoForSeason(getReadModelClient(), season)
        : buildShowInfoForSeason(getShowTitlesBigDb(), season),
    catch: (e) => new Error(`Failed to query show info: ${String(e)}`),
  });

  showInfoCache.set(season, { expiresAt: Date.now() + SHOW_TITLES_CACHE_MS, value: info });
  return info;
});

// Full show detail for one show, keyed by the stable (corpsKey, season). Hybrid
// read: rm_show_detail in production, the relational fallback in dev — same shared
// builder both sides so they can't drift. This is the SCRAPED half of the
// show-detail wiki overlay; the app merges contributions on top at read time.
const showDetailCache = new Map<string, { expiresAt: number; value: ShowDetail | null }>();

export const readScrapedShowDetail = async (
  corpsKey: string,
  season: string
): Promise<ShowDetail | null> => {
  const key = `${corpsKey}|${season}`;
  const cached = showDetailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await (readModelEnabled()
    ? readShowDetail(getReadModelClient(), corpsKey, season)
    : buildShowDetail(getShowTitlesBigDb(), corpsKey, season));

  showDetailCache.set(key, { expiresAt: Date.now() + SHOW_TITLES_CACHE_MS, value });
  return value;
};

export const getShowDetail = createServerFn({ method: 'GET' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }): Promise<ShowDetail | null> => {
    return readScrapedShowDetail(data.corpsKey, data.season);
  });

// List the corps directory (cards + logos)
export const getCorpsDirectory = createServerFn({ method: 'GET' }).handler(async () => {
  if (corpsDirectoryCache && corpsDirectoryCache.expiresAt > Date.now()) {
    return corpsDirectoryCache.value;
  }
  const program = Effect.flatMap(CorpsDirectoryService, (s) => s.listCorps()).pipe(provideServices);
  const value = await Effect.runPromise(program);
  corpsDirectoryCache = { expiresAt: Date.now() + CORPS_DIRECTORY_CACHE_MS, value };
  return value;
});

// Get a single corps by slug (null when not found)
export const getCorps = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(CorpsDirectoryService, (s) => s.getCorps(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// A corps's current-season score timeline (predicted + actual, with a derived
// uncertainty band) for the profile-page chart.
export const getCorpsSeasonScores = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(CorpsDirectoryService, (s) => s.getSeasonScores(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// List 2026 events
export const getHybridEventDirectory = createServerFn({
  method: 'GET',
}).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (s) => s.list2026Events()).pipe(
    provideServices
  );

  return Effect.runPromise(program);
});

// Single event directory row by slug, including the readiness counts used by
// prediction page headers. Avoids loading a full season directory on year switch.
export const getHybridEvent = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) => s.getEvent(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Lightweight event lookup for prediction pages — skips the heavy CTEs
// (venue, schedule counts, participant counts) that the full directory computes.
export const getHybridEventBasic = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) => s.getEventBasic(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Fetch corps by specific keys — much faster than loading the entire directory
// when you only need the corps that appear in a prediction recap.
export const getCorpsByKeys = createServerFn({ method: 'POST' })
  .validator((corpsKeys: string[]) => corpsKeys)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(CorpsDirectoryService, (s) => s.getCorpsByKeys(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

export const getHybridEventForSeason = createServerFn({ method: 'GET' })
  .validator((data: { season: string; slug: string }) => data)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) =>
      s.getEventForSeason(data.season, data.slug)
    ).pipe(provideServices);
    return Effect.runPromise(program);
  });

export const getHybridCompetitionSlugForSeason = createServerFn({
  method: 'GET',
})
  .validator((data: { season: string; slug: string }) => data)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) =>
      s.competitionSlugForSeason(data.season, data.slug)
    ).pipe(provideServices);
    return Effect.runPromise(program);
  });

// Full schedule for one event (every entry, with times — performances and the
// ceremony/break/exhibition segments alike).
export const getHybridEventSchedule = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) => s.eventSchedule(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// The event's "about" blurb (latest non-empty scraped about_text, or null).
export const getHybridEventAbout = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) => s.eventAbout(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Seasons where the same recurring show appears, used by the prediction title
// year switcher.
export const getHybridEventSeasonOptions = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = cachedEventSeasonOptions(data).pipe(provideServices);
    return Effect.runPromise(program);
  });

// Events a corps appears in (directory rows) for the corps "Appearances" section.
export const getCorpsAppearances = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) => s.corpsAppearances(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Per-appearance results (place + total) for the corps profile's appearance cards,
// keyed by the appearance card key (event_id ?? slug).
export const getCorpsAppearanceResults = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventDirectoryService, (s) =>
      s.corpsAppearanceResults(data)
    ).pipe(provideServices);
    return Effect.runPromise(program);
  });

// List events across all seasons (for the season-filtered /events page)
export const getHybridAllEvents = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (s) => s.listAllSeasonEvents()).pipe(
    provideServices
  );

  return Effect.runPromise(program);
});

// Get latest refresh status
export const getHybridRefreshStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (s) => s.latest2026Refresh()).pipe(
    provideServices
  );

  return Effect.runPromise(program);
});

// Trigger background refresh (complex op)
export const startHybridRefresh = createServerFn({ method: 'POST' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (s) => s.start2026Refresh()).pipe(
    provideServices
  );

  return Effect.runPromise(program);
});

// Cache-only prediction lookup (returns null when not cached). Used by the route
// loader so navigation is instant — it never triggers the heavy ML generation.
export const getCachedHybridPrediction = createServerFn({ method: 'POST' })
  .validator((data: EventPredictionRequest) => data)
  .handler(async ({ data }) => {
    if (!data?.slug) {
      throw new Error('slug is required for prediction');
    }
    const program = Effect.flatMap(EventPredictionService, (s) =>
      s.getCached2026EventPrediction(data)
    ).pipe(provideServices);
    return Effect.runPromise(program);
  });

// Get or create prediction for an event (the heavy ML operation)
export const getHybridPrediction = createServerFn({ method: 'POST' })
  .validator((data: EventPredictionRequest) => data)
  .handler(async ({ data }) => {
    if (!data?.slug) {
      throw new Error('slug is required for prediction');
    }
    const program = Effect.flatMap(EventPredictionService, (s) =>
      s.getOrCreate2026EventPrediction(data)
    ).pipe(provideServices);
    return Effect.runPromise(program);
  });

// Actual recap scores for a past-season competition (from relational DB).
export const getHybridEventRecap = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }): Promise<{ meta: any | null; scores: any[] }> => {
    const program = Effect.flatMap(EventRecapService, (s) => s.getEventRecap(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Full DCI-style recap (per-judge + subcaption breakdown). Fetched lazily when
// the user expands the full recap, so it stays off the route's critical path.
export const getHybridEventFullRecap = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(EventRecapService, (s) => s.getEventFullRecap(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// One compact page-data boundary for event prediction/recap routes. This avoids
// issuing several server-fn requests from a route loader and keeps DB reads on
// the shared service clients.
export const getHybridEventPredictionPageData = createServerFn({
  method: 'POST',
})
  .validator((data: { yearSlug: string; slug: string }) => data)
  .handler(async ({ data }): Promise<EventPredictionPageData> => {
    const program = Effect.gen(function* () {
      if (data.yearSlug === '2026') {
        // `showTitles` takes a static season arg (no dependency on the corps
        // fetch below), so fan it out with the first batch instead of as a
        // serial hop after `getCorpsByKeys`.
        const [prediction, event, schedule, seasonOptions, showInfo] = yield* Effect.all(
          [
            Effect.flatMap(EventPredictionService, (s) =>
              s.getCached2026EventPrediction({
                slug: data.slug,
                mode: 'auto',
                force: false,
                refresh: false,
              })
            ),
            Effect.flatMap(EventDirectoryService, (s) => s.getEventBasic(data.slug)),
            Effect.flatMap(EventDirectoryService, (s) => s.eventSchedule(data.slug)),
            cachedEventSeasonOptions(data.slug),
            getShowInfoForSeason('2026'),
          ],
          { concurrency: 'unbounded' }
        );
        const showTitles = Object.fromEntries(
          Object.entries(showInfo).map(([corpsKey, info]) => [corpsKey, info.title])
        );

        const predictionKeys = uniqueStrings(
          (prediction?.recap ?? []).map((row: any) => row.corps_key)
        );
        const scheduleKeys = uniqueStrings(schedule.map((row: any) => row.corps_key));
        // Union prediction + schedule keys: corps the V9 model doesn't score
        // (e.g. alumni units on a parade lineup) still appear in the table and
        // need their directory row for the logo/link/class chip.
        const corpsKeys = uniqueStrings([...predictionKeys, ...scheduleKeys]);
        const corps =
          corpsKeys.length > 0
            ? yield* Effect.flatMap(CorpsDirectoryService, (s) => s.getCorpsByKeys(corpsKeys))
            : [];

        return {
          prediction,
          event,
          schedule,
          corps,
          recap: null,
          seasonOptions,
          showTitles,
          showInfo,
        };
      }

      // PAST-SEASON branch. KEEP IN LOCKSTEP with readPredictionPageData in
      // sdk/src/readModel/readers.ts — the emitter freezes this exact composition
      // into the static prediction-page/<season>/<slug>.json shard the route reads
      // on client nav. If this logic changes, change the composer too.
      //
      // Only `recap` and the competition-slug-keyed schedule actually depend on
      // the slug lookup; `event`, the slug-keyed fallback schedule, and the
      // season options key off `data.slug` directly — so run them concurrently
      // with the lookup instead of waiting on it.
      const [competitionSlug, event, fallbackSchedule, seasonOptions] = yield* Effect.all(
        [
          Effect.flatMap(EventDirectoryService, (s) =>
            s.competitionSlugForSeason(data.yearSlug, data.slug)
          ),
          Effect.flatMap(EventDirectoryService, (s) => s.getEventBasic(data.slug)),
          Effect.flatMap(EventDirectoryService, (s) => s.eventSchedule(data.slug)),
          cachedEventSeasonOptions(data.slug),
        ],
        { concurrency: 'unbounded' }
      );
      const [recap, primarySchedule, showInfo, fullRecap] = yield* Effect.all(
        [
          Effect.flatMap(EventRecapService, (s) => s.getEventRecap(competitionSlug)),
          Effect.flatMap(EventDirectoryService, (s) => s.eventSchedule(competitionSlug)),
          getShowInfoForSeason(data.yearSlug),
          // The page also renders the full (judge-level) recap, which can cover
          // more corps than the compact recap — e.g. a two-night event whose full
          // recap merges both nights. Union its corps so every rendered row has a
          // directory row for its logo/link/class chip (else it degrades to a
          // monogram).
          Effect.flatMap(EventRecapService, (s) => s.getEventFullRecap(data.slug)),
        ],
        { concurrency: 'unbounded' }
      );
      const schedule = primarySchedule.length > 0 ? primarySchedule : fallbackSchedule;
      const recapKeys = uniqueStrings(recap.scores.map((row: any) => row.corps_key));
      const scheduleKeys = uniqueStrings(schedule.map((row: any) => row.corps_key));
      const fullRecapKeys = uniqueStrings(fullRecap.corps.map((c: any) => c.corpsKey));
      const corpsKeys = uniqueStrings([...recapKeys, ...scheduleKeys, ...fullRecapKeys]);
      const corps =
        corpsKeys.length > 0
          ? yield* Effect.flatMap(CorpsDirectoryService, (s) => s.getCorpsByKeys(corpsKeys))
          : [];

      return {
        prediction: null,
        event,
        schedule,
        corps,
        recap: { meta: recap.meta, scores: recap.scores as any[] },
        seasonOptions,
        showTitles: Object.fromEntries(
          Object.entries(showInfo).map(([corpsKey, info]) => [corpsKey, info.title])
        ),
        showInfo,
      };
    }).pipe(provideServices);

    return Effect.runPromise(program);
  });

export const getJudgeDirectory = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(JudgeDirectoryService, (s) => s.listJudges()).pipe(
    provideServices
  );
  return Effect.runPromise(program);
});

export const getJudgeProfile = createServerFn({ method: 'GET' })
  .validator((judgeId: string) => judgeId)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(JudgeDirectoryService, (s) => s.getJudgeProfile(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

export const getStaffDirectory = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(StaffDirectoryService, (s) => s.listStaff()).pipe(provideServices);
  return Effect.runPromise(program);
});

export const getStaffProfile = createServerFn({ method: 'GET' })
  .validator((personId: string) => personId)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(StaffDirectoryService, (s) => s.getStaffProfile(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// ── Merch (MERCH_PLAN §6) ────────────────────────────────────────────────────
// Fallback path only: the happy path is the static shards under /read-model/merch
// (loaded via loadDetailOrServer). These thin server fns delegate to
// MerchDirectoryService (Effect) — it owns the shared client, the tagged-error
// channel, and the TTL-cached snapshot, so shard and fallback can't drift.
export const getMerchStores = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(MerchDirectoryService, (s) => s.listStores()).pipe(
    provideServices
  );
  return Effect.runPromise(program);
});

export const getMerchFacets = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(MerchDirectoryService, (s) => s.getFacets()).pipe(provideServices);
  return Effect.runPromise(program);
});

export const getMerchCatalogPage = createServerFn({ method: 'GET' })
  .validator((page: number) => page)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(MerchDirectoryService, (s) => s.getCatalogPage(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

// Full catalog index (all summaries) — the shop page filters/sorts/paginates over
// the complete set client-side, so a store/price/category filter finds matches on
// any "page", not just the first one loaded.
export const getMerchCatalog = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(MerchDirectoryService, (s) => s.getCatalog()).pipe(
    provideServices
  );
  return Effect.runPromise(program);
});

// ── Shop landing / scoped pages ──────────────────────────────────────────────
// Group/store logos are joined onto the merch store records at build time (see
// buildMerchStores), so these payloads are compact and ready-to-render without a
// separate corps lookup that could miss rm_corps-absent corps.

// Landing payload: group cards (with corps logos) + category cards (with a
// representative product image), both derived from the in-memory snapshot.
export const getShopHome = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.gen(function* () {
    const merch = yield* MerchDirectoryService;
    const [stores, catalog, facets] = yield* Effect.all([
      merch.listStores(),
      merch.getCatalog(),
      merch.getFacets(),
    ]);

    const storeSample = new Map<string, string>();
    const catSample = new Map<string, string>();
    for (const p of catalog.items) {
      if (!p.image) continue;
      if (!storeSample.has(p.storeId)) storeSample.set(p.storeId, p.image);
      if (p.category && !catSample.has(p.category)) catSample.set(p.category, p.image);
    }

    const groups = stores
      .filter((s) => s.productCount > 0)
      .map((s) => ({
        storeId: s.storeId,
        slug: s.slug,
        name: s.name,
        count: s.productCount,
        // Logo is joined onto the store at merch-build time, so it resolves even
        // for corps absent from rm_corps (e.g. duplicate-key corps like northern-lights).
        logo: s.logo,
        storeLogo: s.storeLogo,
        sampleImage: storeSample.get(s.storeId) ?? null,
      }))
      .sort((a, b) => b.count - a.count);

    const categories = facets.categories.map((c) => ({
      value: c.value,
      count: c.count,
      sampleImage: catSample.get(c.value) ?? null,
    }));

    return { groups, categories };
  }).pipe(provideServices);
  return Effect.runPromise(program);
});

// A single group's storefront: header (logo/name/count), the group's own
// categories, and all of its products. Returns null when the store is unknown.
export const getShopGroup = createServerFn({ method: 'GET' })
  .validator((idOrSlug: string) => idOrSlug)
  .handler(async ({ data: idOrSlug }) => {
    const program = Effect.gen(function* () {
      const merch = yield* MerchDirectoryService;
      const [stores, catalog] = yield* Effect.all([merch.listStores(), merch.getCatalog()]);
      // Resolve by human-readable slug first; fall back to the raw store_id so
      // older /shop/group/<id> links (and Salesforce-id stores) keep resolving.
      const key = idOrSlug.trim().toLowerCase();
      const store =
        stores.find((s) => s.slug.toLowerCase() === key) ??
        stores.find((s) => s.storeId.toLowerCase() === key);
      if (!store) return null;

      const products = catalog.items.filter((p) => p.storeId === store.storeId);
      const counts = new Map<string, number>();
      for (const p of products) {
        if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      }
      const categories = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);

      return {
        storeId: store.storeId,
        slug: store.slug,
        name: store.name,
        storeUrl: store.storeUrl,
        count: store.productCount,
        // Joined onto the store at merch-build time (resolves regardless of rm_corps).
        logo: store.logo,
        storeLogo: store.storeLogo,
        categories,
        products,
      };
    }).pipe(provideServices);
    return Effect.runPromise(program);
  });

// A single category across all groups. Returns null when the category is unknown.
export const getShopCategory = createServerFn({ method: 'GET' })
  .validator((value: string) => value)
  .handler(async ({ data: value }) => {
    const program = Effect.gen(function* () {
      const merch = yield* MerchDirectoryService;
      const catalog = yield* merch.getCatalog();
      const products = catalog.items.filter((p) => p.category === value);
      if (products.length === 0) return null;
      return { value, count: products.length, products };
    }).pipe(provideServices);
    return Effect.runPromise(program);
  });

export const getMerchProduct = createServerFn({ method: 'GET' })
  .validator((productId: string) => productId)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(MerchDirectoryService, (s) => s.getProduct(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });

export const getCorpsMerch = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data }) => {
    const program = Effect.flatMap(MerchDirectoryService, (s) => s.getCorpsTeaser(data)).pipe(
      provideServices
    );
    return Effect.runPromise(program);
  });
