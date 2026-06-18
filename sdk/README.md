# Corps Place SDK

Effect-TS powered wrapper around the public DCI API with strong schemas, built-in retries, rate limiting, and a customizable caching layer.

## Features

- Runtime schemas via `@effect/schema` that coerce stringly typed numeric fields and guarantee the shapes of competitions, corps, and recap payloads.
- Resiliency primitives (exponential backoff + jitter, rate limiting, spans) baked in through Effect schedules and semaphores.
- Observability hooks through the `DciObservability` service so every HTTP call, cache hit/miss, and pagination round emits structured telemetry (opt-in logger + metric layers included).
- Configurable cache per resource namespace so long-lived data (corps, season list) can live longer than volatile recap pages, plus a persistent SQLite cache powered by `@effect/sql` / `@effect/sql-libsql`.
- Latest-season helpers (`getLatestSeason`, `getLatestRecap`, `getCurrentStandings`, `getCurrentSeasonRankings`, `getLatestEvent`, `getClosestEvents`, `watchLatestRecaps`) so bots can surface the freshest scores or nearby events without reimplementing pagination loops.
- Escape hatches to run ad-hoc requests through `rawPaginated` or warm caches ahead of batch data jobs.
- Drop-in replacements for the legacy `Convert` helpers: `RecapSchemas` exports Effect schemas + encode/decode helpers for `DciSeason`, `Caption`, and related types so you can validate JSON dumps directly.
- Typed wrappers for events, media galleries, sponsors, page content, competitions, and past-champion history plus fluent query builders (`eventsQuery()`, `competitionsQuery()`, `performancesQuery()`, etc.) and streaming helpers.
- Season analytics helpers via `buildSeasonDataset` / `collectSeasonDatasets` that replicate the historic "loop seasons, fetch competitions, compute recaps & judge maps" workflow entirely with Effect + schemas.
- Recap analysis utilities (`buildCompetitionRecapSummary`, `buildCaptionLeaderboards`, `buildRecapTable`, `formatRecapLine`, `formatCorpsRecapLine`, `compareRecapScores`, `buildRecapInsights`, `buildRecapReport`, etc.) so you can turn raw recap payloads into leaderboards, judge maps, highlights, and formatted strings without rewriting the same traversals.
- Optional HTTP proxy server built with `@effect/platform` so local apps can forward `/dci-api/*` requests without standing up an ad-hoc Express app.
- DX niceties such as pagination streams (no more manual `page` loops) and a `makeDciApiMock` helper for unit tests that need deterministic responses.

## API Coverage

| Endpoint                                                 | SDK helper                                       | Notes                                                 |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `GET /competitions/seasons`                              | `getSeasons()`                                   | Cached (memory / SQLite)                              |
| `GET /competitions?season=YYYY`                          | `getCompetitions(season)`                        | Cached & auto-paginated                               |
| `GET /competitions`                                      | `listCompetitions(query)` / `streamCompetitions` | Supports pagination + filters (`competitionsQuery()`) |
| `GET /competitions/{slug}`                               | `getCompetitionRecap(slug)`                      | Cached                                                |
| `GET /performances`                                      | `listPerformances(query)` / `streamPerformances` | Supports fluent builder                               |
| `GET /performances/classes`                              | `getPerformanceClasses()`                        | Cached                                                |
| `GET /performances/corps`                                | `getPerformanceCorps()`                          | Cached                                                |
| `GET /events`                                            | `listEvents()` / `streamEvents()`                | Fluent builder                                        |
| `GET /events/corps`, `/events/regions`, `/events/states` | `getEventCorps/Regions/States()`                 | Cached                                                |
| `GET /galleries`                                         | `listGalleries()` / `streamGalleries()`          | Normalizes assets                                     |
| `GET /competitions/locations`                            | `getCompetitionLocations()`                      | Cached                                                |
| `GET /sponsors`                                          | `getSponsors()`                                  | Cached                                                |
| `GET /page-content`                                      | `getPageContent()`                               | Cached                                                |
| `GET /past-champions`                                    | `getPastChampions()`                             | Cached                                                |

## Getting Started

```sh
cd sdk
npm install           # installs effect, schema, platform, typescript
npm run build         # emits dist/* for publishing or linking
```

> The repository root already depends on `effect`, but the SDK has its own package manifest so it can be published or versioned independently. Run installs from `sdk/` so the extra packages (`@effect/schema`, `@effect/platform`) are available when you run `tsc`.

## Usage

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { makeDciApiLayer, DciApi } from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const api = yield* _(DciApi);
  const seasons = yield* _(api.getSeasons());
  const currentSeason = seasons.at(-1);
  if (!currentSeason) return;

  const competitions = yield* _(api.getCompetitions(currentSeason));
  const finals = competitions.find((c) => c.recapReleased && c.slug);
  if (!finals?.slug) return;

  const recap = yield* _(api.getCompetitionRecap(finals.slug));
  const topThree = recap
    .filter((score) => score.divisionName === "World Class")
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 3);

  for (const corps of topThree) {
    yield* _(
      Effect.log(`#${corps.rank} ${corps.groupName}: ${corps.totalScore}`),
    );
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

### Event + Media APIs

Query the public listings the same way the website does:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { DciApi, makeDciApiLayer } from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const api = yield* _(DciApi);

  const [corpsDirectory, regions] = yield* _(
    Effect.all([api.getEventCorps(), api.getEventRegions()]),
  );
  console.log(`Directory entries: ${Object.keys(corpsDirectory).length}`);
  console.log(`Regions: ${regions.join(", ")}`);

  const events = yield* _(
    api.listEvents(
      {
        season: "2023",
        startDate: { op: ">", value: "2023-06-20" },
        perPage: 5,
      },
      { fetchAllPages: false }, // keep pagination server-side
    ),
  );

  const galleries = yield* _(
    api.listGalleries({ corpId: "001j000000IWxAFAA1", perPage: 2 }),
  );
  const performanceHistory = yield* _(
    api.listPerformances({
      season: "2019",
      corp: "Blue Devils",
      sort: "startDate",
    }),
  );

  console.log(
    `Fetched ${events.length} events, ${galleries.length} galleries, ${performanceHistory.length} recaps`,
  );
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

### Fluent Queries & Streams

Skip manual query strings or pagination loops:

```ts
import { Effect, Stream } from "effect";
import { NodeContext } from "@effect/platform-node";
import { DciApi, eventsQuery, competitionsQuery } from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const api = yield* _(DciApi);
  const upcoming = eventsQuery()
    .season("2025")
    .startDateOnOrAfter("2025-06-01")
    .sort("startDate");

  // Pull everything into memory
  const allEvents = yield* _(api.listEvents(upcoming.build()));

  // Or stream it page-by-page
  const streamed = api.streamEvents(upcoming.build());
  yield* _(
    Stream.runForEach(streamed, (event) =>
      Effect.log(
        `Event ${event.name} @ ${event.locationCity ?? event.venueCity}`,
      ),
    ),
  );

  const tour = competitionsQuery()
    .season("2024")
    .division("World Class")
    .sort("date");
  const nextStops = yield* _(
    api.listCompetitions(tour.build(), { fetchAllPages: false }),
  );
  console.log(
    `Next ${nextStops.length} shows: ${nextStops.map((show) => show.eventName).join(", ")}`,
  );
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

### Recap Utilities

### Latest Season Helpers

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  getLatestSeason,
  getLatestRecap,
  getCurrentStandings,
  getCurrentSeasonRankings,
  getLatestEvent,
  getClosestEvents,
  watchLatestRecaps
} from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const season = yield* _(getLatestSeason());
  if (!season) return;

  const latest = yield* _(getLatestRecap({ season }));
  if (latest) {
    const standings = yield* _(getCurrentStandings({ season }));
    yield* _(Effect.log(`Latest recap: ${latest.competition.eventName}`));
    if (standings) {
      yield* _(Effect.log(`Leaders: ${standings.standings
        .slice(0, 3)
        .map((row) => row.corps)
        .join(", "))}`));
    }
  }

  const rankings = yield* _(getCurrentSeasonRankings({ season }));
  if (rankings) {
    const snapshot = rankings.snapshots.at(-1);
    yield* _(Effect.log(`Snapshots captured: ${rankings.snapshots.length}`));
    yield* _(Effect.log(`Latest total leader: ${snapshot?.rankings.total?.[0]?.corps ?? "TBD"}`));
  }

  const nextEvent = yield* _(getLatestEvent({ season }));
  if (nextEvent) {
    yield* _(Effect.log(`Next event: ${nextEvent.name} (${nextEvent.locationCity ?? nextEvent.venueCity ?? "TBD"})`));
  }

  const nearby = yield* _(getClosestEvents(new Date(), 3 * 24 * 60 * 60 * 1000, { season, limit: 3 }));
  if (nearby.length > 0) {
    yield* _(Effect.log(`Events within 3 days: ${nearby.map((event) => event.name).join(", ")}`));
  }

  const fiber = yield* _(
    watchLatestRecaps((update) =>
      Effect.log(`New recap posted: ${update.competition.eventName}`)
    ).pipe(Effect.fork)
  );

  yield* _(Effect.sleep("30 seconds"));
  yield* _(Effect.interrupt(fiber));
});

Effect.runPromise(program.pipe(Effect.provide(NodeContext.layer)));
```

Turn the raw `/competitions/{slug}` payload into richer structures:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  DciApi,
  buildCompetitionRecapSummary,
  buildCaptionLeaderboards,
  formatRecapLine,
} from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const api = yield* _(DciApi);
  const [competition] = yield* _(api.getCompetitions("2023"));
  if (!competition?.slug) return;

  const recapScores = yield* _(api.getCompetitionRecap(competition.slug));
  const recap = buildCompetitionRecapSummary(competition, recapScores);

  const leaderboards = buildCaptionLeaderboards(recapScores, {
    top: 3,
    includeSubcaptions: true,
  });
  const headline = formatRecapLine(recap.scores[0], {
    includeCaptions: true,
    captionLimit: 3,
  });
  const winnerHeadline = formatCorpsRecapLine(recap.scores[0], {
    includeCaptions: false,
  });
  const insights = buildRecapInsights(recap, { captionLimit: 5 });
  const comparison = compareRecapScores(recap, "Blue Devils", "The Cavaliers");

  yield* _(Effect.log(headline));
  yield* _(
    Effect.log(
      `GE leaders: ${leaderboards.captions["General Effect"].map((entry) => entry.corps).join(", ")}`,
    ),
  );
  yield* _(
    Effect.log(
      `Margin of victory: ${insights.marginOfVictory?.toFixed(3) ?? "N/A"}`,
    ),
  );
  if (comparison) {
    yield* _(
      Effect.log(
        `Caption spreads: ${comparison.captionBreakdown
          .slice(0, 2)
          .map((entry) => `${entry.label} ${entry.spread.toFixed(3)}`)
          .join(", ")}`,
      ),
    );
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

#### High-Level Recap Reports

Need a ready-to-print recap summary? `buildRecapReport` orchestrates the summary, insights, leaderboards, formatted table, and optional head-to-head comparisons:

```ts
import { buildRecapReport, formatRecapReport } from "@corps-place/sdk";

const recapScores = yield * _(api.getCompetitionRecap(competition.slug));
const report = buildRecapReport(competition, recapScores, {
  leaderboardTop: 3,
  autoCompareTop: 2,
});

yield * _(Effect.log(formatRecapReport(report, { includeComparisons: true })));
```

The resulting object is easy to feed into a UI (table rows, headline string, comparisons array, etc.) or render back to text for Discord/Slack bots.

## Season Analytics

Recreate the original multi-season crawl in a type-safe way:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  collectSeasonDatasets,
  makeDciApiLayer,
  DciApi,
} from "@corps-place/sdk";

const seasons = ["2022", "2023"];

const program = Effect.gen(function* (_) {
  yield* _(DciApi); // ensures the service is in scope
  const datasets = yield* _(collectSeasonDatasets(seasons));

  for (const season of seasons) {
    const summary = datasets[season]?.season;
    if (!summary) continue;
    console.log(
      `${season}: ${summary.seasonLength} days, ${datasets[season].recaps.length} shows`,
    );
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

### Observability

Wire in per-request logging, metrics, tracing, or in-flight instrumentation by providing a `DciObservability` service (logger + telemetry layers ship with the SDK) and the optional `DciRequestSupervisor`:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  makeDciApiLayer,
  DciObservabilityLoggerLayer,
  DciObservabilityTelemetryLayer,
  DciRequestSupervisorLayer,
} from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  // ...
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(DciObservabilityLoggerLayer({ level: "info" })), // structured logs
    Effect.provide(DciObservabilityTelemetryLayer()), // metrics (counters + histogram)
    Effect.provide(DciRequestSupervisorLayer()), // track in-flight requests
    Effect.provide(NodeContext.layer),
  ),
);
```

Implement your own `DciObservability` to forward telemetry to tracing or log aggregators—each HTTP attempt reports start/success/failure timings and paginated/cached calls emit additional signals. The telemetry layer exposes ready-to-scrape metrics (`dci_http_requests_total`, `dci_http_request_duration_ms`, cache hit/miss/populate counters, etc.) while the supervisor lets you expose `inFlight` gauges or cancel all running fetches when your app shuts down.

### Persistent Cache Modes

The SDK defaults to an in-memory cache per resource namespace. Flip the switch to SQLite (backed by `@effect/sql` + `@effect/sql-libsql`) when you need cached data to live across process restarts:

```ts
const apiLayer = makeDciApiLayer({
  cache: {
    mode: "sqlite",
    sqlite: {
      url: "file:./dci-cache.db",
      table: "dci_cache_entries",
    },
  },
});
```

The same settings can come from the Effect config service. `makeDciApiLayerFromConfig()` understands the following keys (all optional):

| Key                           | Description                              |
| ----------------------------- | ---------------------------------------- |
| `DCI_API_BASE_URL`            | Override the upstream API root           |
| `DCI_CACHE_MODE`              | `"memory"`, `"sqlite"`, or `"none"`      |
| `DCI_CACHE_SQLITE_URL`        | SQLite/LibSQL connection string          |
| `DCI_CACHE_SQLITE_AUTH_TOKEN` | Optional auth token for LibSQL           |
| `DCI_CACHE_SQLITE_TABLE`      | Table name (default `dci_cache_entries`) |

When `DCI_CACHE_SQLITE_URL` is provided the SDK automatically switches to the persistent cache. Because the cache layer is implemented with `@effect/sql`, you can bring your own `SqlClient` layer as well (e.g. a shared LibSQL client with connection pooling).

## HTTP Proxy Server

Need a local `/dci-api/*` proxy without wiring up Express middleware? The SDK ships with a tiny server built on `@effect/platform`. It streams requests to the upstream API, rewrites headers, and optionally emits permissive CORS headers so your browser code can hit `localhost`.

```ts
import { Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { makeDciProxyServerLayer } from "@corps-place/sdk";

const program = Layer.launch(
  makeDciProxyServerLayer({
    prefix: "/dci-api",
    target: "https://api.dci.org/api/v1",
    port: 8787,
  }),
);

NodeRuntime.runMain(program);
```

The proxy respects the same environment variables as the Astro dev server, so you can configure it via any `ConfigProvider`:

| Key                         | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `DCI_API_PROXY_PREFIX`      | Path prefix to match (default `/dci-api`)                |
| `DCI_API_PROXY_TARGET`      | Upstream base URL (default `https://api.dci.org/api/v1`) |
| `DCI_API_PROXY_PORT`        | Listening port (default `8787`)                          |
| `DCI_API_PROXY_HOST`        | Listening host/interface                                 |
| `DCI_API_PROXY_CORS_ORIGIN` | If set, adds an `Access-Control-Allow-Origin` header     |

`makeDciProxyServerLayerFromConfig` reads those keys using the Effect configuration module so you can keep prod/dev settings in one place.

## Ranking Helpers

Convert a `SeasonDataset` into a day-by-day leaderboard with the same caption/subcaption filtering logic you outlined:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  buildSeasonRankings,
  collectSeasonDatasets,
  makeDciApiLayer,
  DciApi,
} from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  yield* _(DciApi);
  const datasets = yield* _(collectSeasonDatasets(["2023"]));
  const timeline = yield* _(
    buildSeasonRankings("2023", datasets["2023"], {
      skipCompetition: (comp) => /open class.*finals/i.test(comp.eventName),
    }),
  );

  for (const snapshot of timeline.snapshots) {
    yield* _(
      Effect.log(
        `Day ${snapshot.competition.dayOfSeason}: ${snapshot.competition.eventName} (${Object.keys(snapshot.rankings).length} captions)`,
      ),
    );
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
);
```

Use `SeasonDatasetSchema` (and the nested `CompetitionRecapSummarySchema`) if you persist these structures and want a runtime validator when loading them back.

## Bulk Scraper

Warm the entire dataset—seasons, competitions, recaps, and any extra endpoints you care about—directly into the SQLite cache with a single call. The `scrapeAllData` helper fans out work via Effect `Queue` + `Fiber` workers, deduplicates tasks with `Hash`/`Equivalence`, and reports progress through the existing observability layers:

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { scrapeAllData, makeDciApiLayer } from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  const stats = yield* _(
    scrapeAllData({
      seasons: ["2022", "2023", "2024"],
      includeEvents: true,
      warmInstructions: [{ namespace: "performanceClasses" }],
    }),
  );

  yield* _(
    Effect.log(
      `Scraped ${stats.processed} jobs across ${stats.seasons.length} seasons (skipped ${stats.skipped}).`,
    ),
  );
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer({ cache: { mode: "sqlite" } })),
    Effect.provide(NodeContext.layer),
  ),
);
```

Because the scraper uses the same cache + HTTP client under the hood, every fetch benefits from retries, spans, metrics, and the SQLite persistence layer—perfect for scheduled jobs that need to keep a local cache fresh.

## Relational Ingest

Need answering questions like _“Which judges evaluated Bluecoats at Finals in 2023?”_ without rehydrating JSON each time? The SDK can normalize every recap into a relational schema backed by SQLite/LibSQL so you can issue straight SQL queries.

The ingest workflow:

1. Creates the tables (`corps`, `competitions`, `corps_scores`, `caption_scores`, `judges`, `judge_assignments`, `judge_scores`, `subcaption_scores`).
2. Optionally warms caches via `scrapeAllData` so the crawl doesn’t redownload data you already have.
3. Iterates seasons → competitions → recap payloads, inserting/upserting normalized rows.

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer, ingestRelationalData } from "@corps-place/sdk";

const SqlLayer = LibsqlClient.layer({
  url: "file:./dci-relational.db"
});

const program = ingestRelationalData({
  seasons: ["2023", "2024"], // omit to ingest every available season
  warm: true,
  seasonConcurrency: 2,
  competitionConcurrency: 4
});

Effect.runPromise(
  program.pipe(
    Effect.provide(SqlLayer),
    Effect.provide(makeDciApiLayer({ cache: { mode: "sqlite", sqlite: { url: "file:./dci-cache.db" } } })),
    Effect.provide(NodeContext.layer)
  )
);
```

Once it finishes you can issue queries like:

```sql
SELECT DISTINCT judges.display_name
FROM judge_scores
JOIN judges USING (judge_id)
JOIN competitions ON competitions.slug = judge_scores.competition_slug
WHERE competitions.season = '2023'
  AND competitions.event_name LIKE '%Finals%'
  AND judge_scores.corps_key = 'blue-devils';
```

Because the schema keeps explicit links between competitions, corps, captions, judges, and subcaptions, you can express complex joins ("show me every percussion judge who worked with Vanguard in the last 5 years", "count captions adjudicated by Jane Doe", etc.) directly in SQL.

The relational layer already reserves space for richer data you plan to scrape later:

- `corps_staff`, `corps_staff_links`, `corps_staff_assignments`, and `corps_staff_affiliations` capture staff bios, roles, and cross-corps relationships.
- `corps_shows`, `corps_show_media`, `corps_show_repertoire`, `corps_show_reviews`, and `corps_show_tags` describe show metadata, repertoire, media assets, and press coverage per season.
- `season_participation` records explicit season rosters so you can query "which corps fielded in 2011 Open Class?" without recomputing from recaps.
- `judge_links`, `judge_corps_relations`, and `judge_highlights` preserve long-form biographies, cross-corps judging relationships, and season-specific milestones that your dedicated judge scraper uncovers.

Helper functions like `upsertStaffMember`, `upsertCorpsShow`, and `upsertSeasonParticipationRecord` are exported so your future scraping job can populate these tables as soon as the data sources are ready.

### Judge & Recap Queries

The `judge_scores_enriched` view bakes in all of the joins you need to answer "which shows did judge X cover for corps Y, in season Z, for a given class, and what score did they assign?". Each row contains the season, competition metadata, corps division/class (`division_name`, `group_type_id`, `competition_type_id`), caption name, judge score/rank, and even a ready-to-use API path (`recap_api_url`) back to the originating recap slug.

```sql
SELECT
  event_name,
  competition_date,
  caption_name,
  judge_score,
  corps_rank,
  division_name,
  recap_api_url
FROM judge_scores_enriched
WHERE judge_name = 'John Smith'
  AND corps_key = 'blue-devils'
  AND season = '2023'
  AND division_name = 'World Class'
ORDER BY competition_date;
```

Need every recap in which a particular judge evaluated a corps? Filter by `competition_slug` (or `recap_api_url`) and join to `corps_competition_results` for extra totals. Want to scope by class (e.g., SoundSport only)? Filter on `group_type_id` or `competition_type_id`. The view already contains `season`, `competition_level`, and the `corps_total_score` so you can compute deltas per caption, and because the slug is preserved, you can reconstruct the full recap payload through the SDK or DCI API when needed.

### Populating Staff / Shows / Participation

Scrapers can insert/update the richer data without touching SQL directly:

```ts
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { SqlClient } from "@effect/sql";
import {
  CorpsStaffMemberSchema,
  CorpsShowSchema,
  CorpsSeasonParticipationSchema,
  MediaAssetSchema,
  upsertStaffMember,
  upsertCorpsShow,
  upsertSeasonParticipationRecord,
  upsertMediaAsset
} from "@corps-place/sdk";

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const insertProgram = Effect.gen(function* (_) {
  const sql = yield* _(SqlClient.SqlClient);

  const staffMember = yield* _(CorpsStaffMemberSchema.decode({
    staffId: "staff-123",
    displayName: "Jane Doe",
    assignments: [
      { corpsKey: "blue-devils", season: "2024", title: "Visual Caption Head" }
    ]
  }));
  yield* _(upsertStaffMember(sql, staffMember));

  const show = yield* _(CorpsShowSchema.decode({
    showId: "bd-2024",
    corpsKey: "blue-devils",
    season: "2024",
    title: "Out of the Blue",
    repertoire: [
      { entryId: "bd-2024-1", showId: "bd-2024", workTitle: "Original Composition" }
    ]
  }));
  yield* _(upsertCorpsShow(sql, show));

  const participation = yield* _(CorpsSeasonParticipationSchema.decode({
    season: "2024",
    corpsKey: "blue-devils",
    participationType: "World Class"
  }));
  yield* _(upsertSeasonParticipationRecord(sql, participation));

  const mediaAsset = yield* _(MediaAssetSchema.decode({
    mediaId: "staff-123-headshot",
    ownerType: "staff",
    ownerId: "staff-123",
    url: "https://cdn.example.com/staff/jane.jpg",
    title: "Jane Doe Headshot",
    mediaType: "image",
    thumbnailUrl: "https://cdn.example.com/staff/jane-thumb.jpg"
  }));
  yield* _(upsertMediaAsset(sql, mediaAsset));
});

Effect.runPromise(insertProgram.pipe(Effect.provide(SqlLayer)));
```

Each helper upserts the parent row and all nested child entities (links, assignments, media, repertoire, tags) inside the same transaction-friendly Effect, so your scraper only needs to provide typed data and call the exported helper.

### Claude-Assisted Scraper

If you have the [Claude CLI](https://docs.anthropic.com/claude/docs/cli) installed locally, the SDK can orchestrate research tasks that prompt Claude to gather staff/show/media details from multiple sources (Wikipedia, official corps sites, Wayback Machine, DCI.org, and Google). The `runClaudeScraper` helper walks seasons from newest to oldest, prepares a context-rich prompt per corps/season, and asks Claude to return JSON that already matches the SDK schemas.

```ts
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { LibsqlClient } from "@effect/sql-libsql";
import { runClaudeScraper, makeDciApiLayer } from "@corps-place/sdk";

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = runClaudeScraper({
  claudeCommand: "claude",   // or set CLAUDE_CLI env var
  seasonsLimit: 1,           // start with the latest season
  concurrency: 1             // run prompts sequentially to stay rate-limit friendly
});

Effect.runPromise(
  program.pipe(
    Effect.provide(SqlLayer),
    Effect.provide(makeDciApiLayer({ cache: { mode: "sqlite", sqlite: { url: "file:./dci-cache.db" } } })),
    Effect.provide(NodeContext.layer)
  )
);
```

The script automatically:

1. Fetches the latest seasons/competitions from the DCI API and determines which corps performed.
2. Builds a structured prompt instructing Claude to search Wikipedia, corps sites, Wayback Machine, DCI.org, and Google (in that order) for the requested season.
3. Enforces a strict JSON output contract so the response can be decoded with `CorpsShowSchema`, `CorpsStaffMemberSchema`, `CorpsSeasonParticipationSchema`, and `MediaAssetSchema`.
4. Upserts the decoded objects via the relational helpers (`upsertCorpsShow`, `upsertStaffMember`, `upsertSeasonParticipationRecord`, `upsertMediaAsset`).

> Note: the script assumes your Claude CLI can reach the open web. Keep concurrency low to avoid violating usage policies, and review the resulting JSON before relying on it in production.

Need to focus purely on image/video harvesting? `runClaudeMediaScraper` reuses the same season/task traversal but asks Claude to enumerate high-quality media assets (official photos, TikTok/Instagram reels, YouTube clips, etc.) for each corps season. It outputs an array of `MediaAssetSchema` objects so you can seed thumbnail galleries without parsing HTML twice:

```ts
const mediaProgram = runClaudeMediaScraper({
  seasonsLimit: 1,
  concurrency: 1,
  maxTasks: 5 // cap corps count per season while experimenting
});

Effect.runPromise(
  mediaProgram.pipe(
    Effect.provide(SqlLayer),
    Effect.provide(makeDciApiLayer({ cache: { mode: "sqlite", sqlite: { url: "file:./dci-cache.db" } } })),
    Effect.provide(NodeContext.layer)
  )
);
```

Each task instructs Claude to inspect official sites, social media channels, DCI galleries, Wayback snapshots, and Google results, returning a list of direct media URLs (with platform/format/attribution metadata) that `upsertMediaAsset` stores in the relational DB.

Need richer adjudicator metadata (bios, headshots, cross-corps history, season highlights)? `runClaudeJudgeScraper` walks the latest seasons, aggregates every judge assignment (caption + competition + corps context), and asks Claude to research the person behind the name. The prompt explicitly tells Claude to deduplicate people with the same name, capture alternate spellings, note corps/season relationships, and surface reliable images/interviews. Responses are decoded via `JudgeProfileSchema` and stored with `upsertJudgeProfile`, which fills the new `judges`, `judge_links`, `judge_corps_relations`, `judge_highlights`, and `media_assets` tables.

```ts
import { runClaudeJudgeScraper } from "@corps-place/sdk";

const judgeProgram = runClaudeJudgeScraper({
  claudeCommand: "claude",
  seasonsLimit: 2,
  concurrency: 1,
  maxTasks: 25
});

Effect.runPromise(
  judgeProgram.pipe(
    Effect.provide(SqlLayer),
    Effect.provide(makeDciApiLayer({ cache: { mode: "sqlite", sqlite: { url: "file:./dci-cache.db" } } })),
    Effect.provide(NodeContext.layer)
  )
);
```

Every successful task emits updated bios (with optional alternateNames), attaches research links, and records derived corps/season relations so you can query "which captions has Jane Doe judged, and which corps has she been associated with?" directly from SQLite.

Need to dedupe staff rosters across corps? `compareStaffMembersWithClaude` feeds two `CorpsStaffMemberSchema` objects (e.g., pulled from different seasons/corps) to Claude, instructing it to cross-check bios/photos/link sources and return a JSON verdict:

```ts
import { Effect } from "effect";
import { compareStaffMembersWithClaude, CorpsStaffMemberSchema } from "@corps-place/sdk";

const memberA = yield* _(CorpsStaffMemberSchema.decode({
  staffId: "bd-jane",
  displayName: "Jane Doe",
  assignments: [{ corpsKey: "blue-devils", season: "2024", title: "Visual Caption Head" }],
  photoUrl: "https://cdn.example.com/bd/jane.jpg"
}));
const memberB = yield* _(CorpsStaffMemberSchema.decode({
  staffId: "scv-jane",
  displayName: "Jane Doe",
  assignments: [{ corpsKey: "santa-clara-vanguard", season: "2022", title: "Visual Designer" }],
  links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/janedoe" }]
}));

const verdict = yield* _(compareStaffMembersWithClaude(memberA, memberB));
console.log(verdict.samePerson, verdict.confidence, verdict.rationale);
```

The result includes `samePerson`, `confidence`, `supportingEvidence`, and a recommended action (`merge`, `keep-separate`, or `needs-review`), so you can automate or semi-automate cross-corps staff matching.

Judges can be deduped the same way with `compareJudgesWithClaude`. Feed it two `JudgeProfileSchema` instances (perhaps scraped during different seasons) and it will apply the same reasoning template, flagging whether the bios/photos/links match the same adjudicator despite maiden names, abbreviations, or caption changes.

## Configuration

`makeDciApi` accepts partial overrides of the default configuration:

- `baseUrl`: change the DCI API root (default `https://api.dci.org/api/v1`).
- `retry`: `{ attempts, initialDelayMs, jitter }` for request backoff.
- `rateLimit`: `{ maxConcurrent }` semaphore guarding concurrent HTTP requests.
- `paginationConcurrency`: max number of extra pages fetched in parallel.
- `cache`: toggle caching or change TTL/capacity per namespace (`seasons`, `competitions`, `recaps`, `corps`, `performanceClasses`, `eventCorps`, `eventStates`, `competitionLocations`, `pageContent`, `sponsors`, `pastChampions`, etc.) or switch to the SQLite cache by setting `mode: "sqlite"` plus a `sqlite` block.
- `logRequests`: emit Effect logs for every HTTP call.

Example override:

```ts
const apiLayer = makeDciApiLayer({
  retry: { attempts: 6, initialDelayMs: 200, jitter: true },
  cache: {
    mode: "memory",
    ttlMs: 5 * 60 * 1000,
    capacity: 512,
    namespaces: {
      recaps: { ttlMs: 60 * 1000 },
      corps: { ttlMs: 12 * 60 * 60 * 1000 },
    },
  },
});
```

Warm caches ahead of a bulk export with `DciApi#warmCache`:

```ts
yield *
  _(
    api.warmCache([
      { namespace: "seasons" },
      { namespace: "competitions", season: "2023" },
    ]),
  );
```

This primes the in-memory stores so the subsequent calls return immediately without hitting the network again.

### Configuration via `ConfigProvider`

Prefer the Effect configuration API? `makeDciApiLayerFromConfig` reads `DCI_API_BASE_URL` plus the optional cache keys (`DCI_CACHE_MODE`, `DCI_CACHE_SQLITE_URL`, `DCI_CACHE_SQLITE_AUTH_TOKEN`, `DCI_CACHE_SQLITE_TABLE`) from any `ConfigProvider`.

```ts
import { ConfigProvider, Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { makeDciApiLayerFromConfig } from "@corps-place/sdk";

const program = Effect.gen(function* (_) {
  // ...
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayerFromConfig()),
    Effect.provide(ConfigProvider.fromEnv()), // or a custom provider
    Effect.provide(NodeContext.layer),
  ),
);
```

The exported `DciApiBaseUrlConfig` lets you integrate the base URL into a larger configuration structure if you already model your app's settings with `Config.unwrap`. Likewise, `makeDciProxyServerLayerFromConfig` consumes the `DCI_API_PROXY_*` keys described above so you can boot the proxy alongside your API layer with the same provider.

### Testing / Fixtures

Use the built-in mock helpers to keep tests deterministic:

```ts
import { Effect } from "effect";
import { makeFixtureDciApiLayer, DciApi } from "@corps-place/sdk";

const mockLayer = makeFixtureDciApiLayer({
  seasons: ["2024"],
  competitions: {
    "2024": [
      {
        slug: "mock-finals",
        eventName: "Mock Finals",
        date: new Date(),
        competitionGUID: "1",
        competitionLevel: 0,
        location: "Nowhere",
        chiefJudge: "",
        scoresReleased: true,
        recapReleased: true,
        categoryRecapReleased: true,
        seasonGUID: "1",
        seasonName: "2024",
        groupTypes: [],
      },
    ],
  },
});

const testProgram = Effect.gen(function* (_) {
  const api = yield* _(DciApi);
  const seasons = yield* _(api.getSeasons());
  return seasons.length;
});

Effect.runPromise(testProgram.pipe(Effect.provide(mockLayer)));
```
