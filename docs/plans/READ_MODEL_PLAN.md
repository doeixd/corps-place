# Read-Model & Fast-Reads Plan

**Status:** proposal / not yet started — **key decisions finalized (see §0.1)**
**Author:** drafted with Claude, 2026-06-06
**Scope:** make page reads effectively instant by precomputing a tiny, flat
read-model at ingest time; serve it server-side first, then optionally ship it
to the client for offline. Plus a clear-eyed assessment of the Fate SSR path.

---

## 0. TL;DR / decision

- **The queryable data is tiny** (729 corps, 1,418 events, 1,064 competitions,
  ~7,800 lineup entries). The 3.4 GB `dci-relational.db` is ~99% archive
  (raw scrape HTML, `api_responses`, `website_recaps`, ML feature/sequence
  tables). None of that belongs on the request path.
- **The slowness is derivation, not size.** Page reads run 7+ CTE pipelines,
  `row_number() OVER (...)` classification against `domain_event_exclusion_patterns`,
  fuzzy cross-season series matching, and alias-resolution CTEs — *per request*,
  over a 3.4 GB file — for data that only changes when the ingest pipeline runs.
- **Primary fix: emit a precomputed read-model.** Run all the messy
  CTEs / views / fuzzy matching / data-cleaning **once at the end of ingest**,
  freeze the results into flat tables in a small `read-model.db` (~5–20 MB).
  Per-request work collapses to indexed key lookups.
- **Serve it server-side first** (cheap, no frontend change): point the read
  services at `read-model.db` instead of `dci-relational.db`, set high
  `staleTime`. This alone gets "instant."
- **Then optionally ship it to the client** for offline / zero-latency nav
  (static JSON + service worker, or SQLite-WASM).
- **PowerSync: rejected.** It solves realtime multi-writer partial sync with
  offline writes + conflict resolution. Our data is read-only, single-writer
  (the pipeline), changing a few times a season. All cost, no benefit.
- **TanStack DB: optional, later.** Only if hand-rolled client live-queries get
  painful. Not foundational.
- **Fate SSR (`dehydrate`/`hydrate`): real but largely redundant here** — every
  route except the `fate-events` pilot already SSRs via TanStack loaders calling
  Effect services. Treat Fate SSR as a pilot-page concern, not the speed lever.
- **Fate SSE / live views: not part of the speed story.** It is a
  mutation-push channel; static data has nothing to push. Keep it in the back
  pocket for the one genuine use case: **live score updates on competition nights.**

---

## 0.1 Finalized decisions (2026-06-06)

The emit step produces **two artifacts from the same builders**: a small libSQL
`read-model.db` for the **backend**, and JSON files for the **client/offline**
tier. §4/§5/§8 (the `read-model.db` + `rm_*` schema) are the backend path and
stand as written; §9 (JSON) is the client path.

1. **Backend artifact = libSQL `read-model.db`** (NOT JSON-only — revised).
   - The `rm_*` flat-table schema in §4 stands. Services swap their libSQL client
     URL from `dci-relational.db` → `read-model.db` via `READ_MODEL_DB_URL`
     (§8) and replace CTEs with indexed `SELECT`s. Minimal service change; keeps
     SQL on the server.
   - Builder fallback to the big DB stays for dev / missing-artifact (shared
     builders, §5). One definition, two consumers (emitter persists, service
     falls back).
   - `rm_meta` carries `schema_version`, `built_at`, `source_db_mtime`,
     `ingest_commit`, `current_season`, row counts.
   - Atomic temp-file + rename so the running server never reads a half-written DB
     (§5).

2. **Client/offline artifact = JSON**, emitted alongside the `.db` from the same
   builders (so they can't drift). Two granularities:
   - **Collection files** for list/directory pages: `events.json`, `corps.json`,
     `judges.json` (sorted arrays; ~hundreds of KB).
   - **Per-detail files** for detail pages: `events/<event_id>.json`,
     `corps/<slug>.json`, `recaps/<competition_slug>.json`,
     `predictions/<event_slug>.json`, `judges/<judge_id>.json`.
   - A `meta.json` mirrors `rm_meta`; its `schema_version`/content hash is the SW
     cache-bust key. These files are the offline payload consumed by the service
     worker (§9) — the browser reads JSON, the server reads the `.db`.

2. **Builders location:** `sdk/src/readModel/builders/*` (the SDK already exports
   to the app via `@sdk/...`, and the emitter is a `tsx` SDK script — both reach
   it). One definition, called by emitter (persist) and services (fallback).

3. **Current-season cache = 1 day.**
   - 2026 routes: `staleTime` = 24h. Historical seasons: effectively `Infinity`.
   - Active busting: the in-app refresh already re-runs `seasonUpdateWorkflow`;
     it now also re-emits JSON, bumping `meta.json` version → SW/clients pick up
     new data before the 24h passes. So 1 day is the passive floor, not a ceiling.
   - The on-demand **prediction generation** path stays dynamic (unchanged); only
     the cached prediction *read* shape is precomputed.

4. **Offline scope = pages the user actually saw or that were intent-preloaded.**
   - **Runtime caching, not full precache.** A service worker with a
     `StaleWhileRevalidate` (data/JSON) + `NetworkFirst`/`CacheFirst` (documents/
     assets) runtime cache stores each response as it's fetched.
   - This fits `defaultPreload: 'intent'` for free: hovering a link preloads the
     route loader → fetches that page's JSON → SW runtime-caches it. So
     intent-preload warms the offline cache without a precache manifest.
   - No whole-bundle precache; first-ever visit to an unseen page still needs
     network. Matches the requested scope exactly.
   - Cache versioning keyed on `meta.json` `schema_version` so a new emit
     invalidates stale entries.

5. **Fate: RETAINED — layered on the read-model, sequenced after it.**
   - Fate and the read-model are **different layers, not competitors**: Fate is
     the *client* cache + transport; `read-model.db` is the *server* source.
     Fate's source adapter (`app/fate/sources.ts`) simply points its delegate at
     the read-model-backed services — a near one-line change.
   - **Why keep it:** normalized-cache **cross-page entity consistency** (a corps
     shared across directory / detail / prediction / appearances loads once, no
     refetch/flicker), in-session + back/forward reuse, and — the flagship —
     **live competition-night scores** via `useLiveView`/`live.update`.
   - **Honest caveat:** Fate's cache is **in-memory** and lost on reload;
     `hydrate()` restores from a *server* snapshot, not disk. So Fate does **not**
     provide durable offline — the **SW-cached JSON (§9) is still required** for
     "pages I saw" offline. Final stack = Fate (in-session + live) + SW JSON
     (durable offline) + read-model.db (server source). Three layers, one job each.
   - **Sequencing & gate:** do the read-model first (Phases 0–4) — it's the perf
     win and is Fate-independent. Then expand Fate page-by-page. **Hard gate:**
     fix the pre-existing vinxi/build breakage (AGENTS.md) that leaves the Fate
     HTTP round-trip unverified, before Fate carries real pages.

---

## 1. Current architecture (as built)

### Read path
- Routes (`app/routes/**`) — all except `fate-events.tsx` have a `loader:` that
  calls an Effect service via `Effect.runPromise`, so they SSR with data already.
- Effect services in `app/lib/*`:
  - `EventDirectoryService` (`event-directory.ts`) — directory listings, single
    event, schedule, about, season options, corps appearances, refresh runs.
  - `CorpsDirectoryService` (`corps-directory.ts`) — corps grid, corps detail,
    season-score timeline, corps-by-keys.
  - `EventRecapService` (`event-recap.ts`) — released scores + caption breakdown.
  - `EventPredictionService` (`event-prediction-api.ts`) — cached ML prediction
    read + on-demand generation (spawns a child `tsx` process).
  - `JudgeDirectoryService` (`judge-directory.ts`) — judges (not yet fully read).
- Each service opens **one shared long-lived libsql client** to
  `sdk/dci-relational.db` (`DCI_RELATIONAL_DB_URL` override exists).
- Fate (`app/fate/*`) wraps `EventDirectoryService.list2026Events` behind a
  custom Prisma-style source adapter; only `fate-events.tsx` consumes it, and
  with **no loader** (client-fetch-on-mount → spinner). Live SSE handler mounted
  at `/api/fate/live` but unused for reads.

### The expensive logic (what must move to build time)
All of this is deterministic given an ingest snapshot:

1. **Event directory CTEs** (`listEventsForSeason`, `listAllEvents` in
   `event-directory.ts`): `event_base`, `competition_match` (via
   `event_to_competition` + `competitions`), `lineup_counts`, `time_coverage`
   (the `all_times_present` flag — null/blank/TBD detection), `participant_counts`,
   `schedule_counts`, `judge_counts` (distinct `normalized_caption_name`),
   `prediction_counts` (+ `latest_prediction_at`), `venues` (MIN(venue_id) dedup).
2. **Event schedule classification** (`eventScheduleForSlug`): the inlined
   `classified_event_lineup` logic — `row_number() OVER (PARTITION BY entry_id
   ORDER BY category-priority, pattern-length, pattern)` against
   `domain_event_exclusion_patterns` (categories: `schedule_item` ×30,
   `not_a_corps` ×2, `alumni` ×2, `exhibition` ×5, `model` ×3). Already
   hand-optimized from 114 ms → ~1 ms; that effort vanishes if precomputed.
3. **Corps directory** (`listCorpsRows`): `current_season` (MAX season w/
   lineups), `active_corps` (via `scored_event_lineup` view), `performing_corps`
   (via `season_performing_corps` view), `is_alumni` (pattern + `type` match,
   with the `legacy drum & bugle corps` exception), division allow-list +
   ordering, then **JS-side alias merge** (`mergeDirectoryRows` +
   `normalizeCorpsName` + `corps_aliases`, with `rowCompleteness` tie-break).
4. **Corps appearances / related corps** (`RELATED_CORPS_CTES` in
   `corps-aliases.ts`): bidirectional alias-name resolution → `related_corps`.
5. **Corps season scores** (`seasonScoresForSlug`): latest prediction run per
   event joined to predicted/actual totals across all aliased corps_keys, gated
   on real `scored_event_lineup` presence (the hiatus-corps guard), plus the
   JS-side uncertainty-band derivation (`margin` from `percent_through`).
6. **Event recap** (`event-recap.ts`): competition-slug resolution
   (`event_to_competition` → `competitions`), then `corps_scores` + `caption_scores`
   joined and folded into `RecapRow` via `normalizeCaptionKey` (GE1/GE2/VP/VA/
   CG/MB/MA/MP) and GE/Visual/Music subtotal math.
7. **Cross-season series matching** (`eventSeriesCandidates`,
   `normalizeEventText`, `eventCandidateScore`, `eventSeasonOptionsForSlug`,
   `competitionSlugForSeasonEvent`): fuzzy, heuristic, scored — the single
   gnarliest piece. Pure function of the snapshot.

### Existing DB views (reusable as the emit query source)
`appearances`, `classified_event_lineup`, `scored_event_lineup`,
`season_performing_corps`, `season_participation_view`,
`corps_competition_results`, `event_prediction_readiness`,
`season_ranking_entries_long`, the `dq_*` data-quality views, the
`clean_reference_curve_*` / `reference_curve_metric_stats` views, and
`event_schedules_with_event_order_and_corps_key_and_class_from_that_season`.

> The `dq_*` views are a gift: they already enumerate data-quality edge cases
> (caption/total mismatches, duplicate score entries, invalid caption scores,
> missing caption panels, rank inversions, showcase rows, unknown judges, zero
> scores). The emit step should **read them as guardrails** (see §6).

---

## 2. Goals & non-goals

**Goals**
- Page reads served from a tiny, flat, fully-derived store: lookups, not CTEs.
- All fuzzy/heuristic/cleaning logic runs **once** at ingest, in Node, where it
  can be tested, logged, and audited.
- The big DB stays the durable source; the read-model is a derived artifact
  (consistent with AGENTS.md "volatile tables are rebuildable from the archive").
- Zero behavior change for users initially (byte-identical page output).
- A clean path to offline / client-resident data without rewrites.

**Non-goals (for v1)**
- Replacing Effect/Fate. The services stay; only their data source narrows.
- PowerSync / realtime sync.
- Client SQLite-WASM (kept as an optional later tier).
- Changing the ML prediction *generation* path (still a spawned child process);
  we only precompute the *read* shape of the latest saved prediction.

---

## 3. Target architecture

```
ingest pipeline (seasonUpdateWorkflow, scrapeCorps, ingestLineups, ML, …)
        │  writes
        ▼
  dci-relational.db  (3.4 GB, authoritative, archive + relational)
        │
        │  NEW FINAL STEP: emit-read-model.ts
        │  (runs every CTE/view/fuzzy-match/cleaning ONCE)
        ▼
  read-model.db  (~5–20 MB, flat rm_* tables, indexed)   ← versioned artifact
        │
        ├── server reads: services point here via READ_MODEL_DB_URL
        │       (EventDirectoryService, CorpsDirectoryService, EventRecapService,
        │        JudgeDirectoryService, prediction *read* path)
        │
        └── (tier 2) shipped to client: static JSON snapshot or the .db file
                + service worker  → offline, zero-latency nav
```

### Why a SQLite read-model (not just JSON) for v1
- The services already speak libsql. Pointing them at a 10 MB flat-table DB is a
  one-line URL change per service + flattened queries — **no API/transport churn**.
- Keeps the option open to ship the same `.db` to the browser (SQLite-WASM) later.
- JSON snapshots are then a trivial *export from* the read-model for tier 2.

---

## 4. Read-model schema (`rm_*` flat tables)

Design rule: **one table per page-shaped result; no CTEs at read time; every
filter/sort column indexed; arrays/objects stored as JSON text columns.**

```sql
-- Provenance / cache-busting
CREATE TABLE rm_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);  -- rows: schema_version, source_db_mtime, built_at, ingest_commit, row_counts_json

-- ── Events ────────────────────────────────────────────────────────────────
-- Materializes listAllEvents / listEventsForSeason output, all flags precomputed.
CREATE TABLE rm_events (
  event_id            TEXT,            -- stable key (slugs repeat across seasons)
  slug                TEXT,
  season              TEXT,            -- derived: season|year|substr(start_date,1,4)
  name                TEXT,
  event_name          TEXT,
  start_date          TEXT,            -- UTC ISO midnight Z (see AGENTS.md date note)
  start_time          TEXT,
  web_start_time      TEXT,
  edt_start_time      TEXT,
  timezone            TEXT,
  location_city       TEXT,
  location_state      TEXT,
  venue_name          TEXT,            -- MIN(venue_id) dedup, name+address consistent
  venue_address       TEXT,
  event_image         TEXT,
  event_image_thumb   TEXT,
  competition_slug    TEXT,            -- resolved via event_to_competition fallback
  scores_released     INTEGER,
  recap_released      INTEGER,
  lineup_entries      INTEGER,
  all_times_present   INTEGER,         -- the "Times" readiness chip
  participant_entries INTEGER,
  schedule_entries    INTEGER,
  judge_assignments   INTEGER,
  prediction_runs     INTEGER,
  latest_prediction_at TEXT,
  about_text          TEXT,            -- precomputed eventAboutForSlug (latest non-empty)
  PRIMARY KEY (event_id)
);
CREATE INDEX rm_events_slug    ON rm_events(slug);
CREATE INDEX rm_events_season  ON rm_events(season, start_date);
CREATE INDEX rm_events_compet  ON rm_events(competition_slug);

-- Classified schedule rows (exclusion-pattern classification already applied).
CREATE TABLE rm_event_schedule (
  event_slug          TEXT,
  performance_order   INTEGER,
  unit_name           TEXT,
  time                TEXT,
  is_non_performance  INTEGER,         -- already merged with schedule_item/not_a_corps
  is_exhibition       INTEGER,
  division_name       TEXT,            -- nulled for non-corps rows
  corps_key           TEXT,            -- nulled for non-corps rows
  sort_index          INTEGER          -- precomputed ORDER BY rank for stable output
);
CREATE INDEX rm_event_schedule_slug ON rm_event_schedule(event_slug, sort_index);

-- Cross-season "same series" options + competition resolution, FROZEN.
CREATE TABLE rm_event_season_options (
  source_slug      TEXT,               -- the slug the page was loaded with
  season           TEXT,
  slug             TEXT,
  competition_slug TEXT,
  name             TEXT,
  event_name       TEXT,
  start_date       TEXT,
  location_city    TEXT,
  location_state   TEXT
);
CREATE INDEX rm_event_season_options_src ON rm_event_season_options(source_slug, season DESC);

CREATE TABLE rm_event_competition_resolution (
  season           TEXT,
  slug             TEXT,
  competition_slug TEXT,
  PRIMARY KEY (season, slug)
);

-- ── Corps ─────────────────────────────────────────────────────────────────
-- Materializes the post-merge directory (alias merge already done in build).
CREATE TABLE rm_corps (
  corps_key     TEXT PRIMARY KEY,      -- the surviving (merged) representative
  slug          TEXT,
  name          TEXT,
  division_name TEXT,
  display_city  TEXT,
  corps_logo    TEXT,
  active        INTEGER,
  performing    INTEGER,
  is_alumni     INTEGER,
  aliases_json  TEXT,                  -- JSON string[] of merged alias display names
  sort_index    INTEGER                -- class-then-name ordering, precomputed
);
CREATE INDEX rm_corps_slug ON rm_corps(slug);
CREATE INDEX rm_corps_sort ON rm_corps(sort_index);

-- Corps detail (full record). Separate table: wider, fetched one at a time.
CREATE TABLE rm_corps_detail (
  slug TEXT PRIMARY KEY,
  detail_json TEXT                     -- the full CorpsDetail incl. contact fields
);

-- Maps any corps_key (incl. aliased/duplicate records) → its merged representative.
-- Replaces RELATED_CORPS_CTES at read time.
CREATE TABLE rm_corps_alias_map (
  corps_key            TEXT PRIMARY KEY,
  representative_key    TEXT
);
CREATE INDEX rm_corps_alias_rep ON rm_corps_alias_map(representative_key);

-- Corps season-score timeline (uncertainty band already computed).
CREATE TABLE rm_corps_season_points (
  representative_key TEXT,
  season             TEXT,
  date               TEXT,
  label              TEXT,
  slug               TEXT,
  predicted          REAL,
  actual             REAL,
  low                REAL,
  high               REAL,
  sort_index         INTEGER
);
CREATE INDEX rm_corps_season_pts ON rm_corps_season_points(representative_key, season, sort_index);

-- Corps → event appearances (RELATED_CORPS_CTES result, frozen).
CREATE TABLE rm_corps_appearances (
  representative_key TEXT,
  event_id           TEXT
);
CREATE INDEX rm_corps_appearances_k ON rm_corps_appearances(representative_key);

-- ── Recaps (released scores) ────────────────────────────────────────────────
CREATE TABLE rm_event_recap (
  competition_slug TEXT PRIMARY KEY,
  meta_json        TEXT,               -- {slug,event_name,date,scores_released}
  scores_json      TEXT                -- RecapRow[] (caption fold already done)
);
-- plus event_slug → competition_slug resolution reuses rm_event_competition_resolution
-- (and rm_events.competition_slug for the common case).

-- ── Judges ──────────────────────────────────────────────────────────────────
CREATE TABLE rm_judges (
  judge_id    TEXT PRIMARY KEY,
  summary_json TEXT
);
CREATE TABLE rm_judge_detail (
  judge_id    TEXT PRIMARY KEY,
  detail_json TEXT
);

-- ── Predictions (READ shape of latest saved run only) ───────────────────────
-- The fast "cache-only" read (getCached2026EventPrediction). Generation stays
-- in the big DB via the spawned child; emit just snapshots the latest summary.
CREATE TABLE rm_event_prediction (
  event_slug   TEXT PRIMARY KEY,
  season       TEXT,
  predicted_at TEXT,
  summary_json TEXT                    -- summarizePayload() output, NOT hydrated
);
```

Notes:
- **JSON columns** (`aliases_json`, `detail_json`, `scores_json`, `summary_json`)
  keep wide/nested shapes as one cell — the service parses on read. This avoids
  re-modeling every nested structure as relational while staying tiny.
- **`sort_index`** columns freeze the exact `ORDER BY` the live queries produced,
  so output is byte-identical without re-sorting.
- All `rm_*` tables are disposable; rebuilt wholesale each emit (see §5).

---

## 5. The emit step: `sdk/scripts/emitReadModel.ts`

### Responsibilities
1. Open the source `dci-relational.db` (read-only) and a **fresh** target
   `read-model.db` (write to a temp file, then atomically rename — never mutate a
   read-model the running server holds open).
2. Run each page query **exactly as the services run it today** (reuse the same
   SQL/CTEs/views and the same JS post-processing), then write flat `rm_*` rows.
3. Apply data-cleaning guardrails (see §6) and emit a build report.
4. Stamp `rm_meta` (schema_version, source mtime, built_at, commit, row counts).
5. `PRAGMA optimize` / `ANALYZE`, `VACUUM`, close, atomic rename
   `read-model.db.tmp` → `read-model.db`.

### Crucial: share code with the services (don't fork the SQL)
The risk is drift between the live query and the emit query. Mitigate by
**extracting the SQL + post-processing into shared pure builders** that both the
service (live mode) and the emitter call:

- Move the big query strings + JS folds out of `app/lib/*` into shared modules
  the SDK can import (e.g. `sdk/src/readModel/builders/*` or a shared package),
  exporting functions like:
  - `buildAllEventsRows(db): Promise<EventDirectoryRow[]>`
  - `buildEventSchedule(db, slug)` / or bulk `buildAllSchedules(db)`
  - `buildCorpsDirectory(db): Promise<CorpsSummary[]>` (incl. the alias merge)
  - `buildCorpsAliasMap(db)`, `buildCorpsSeasonPoints(db)`, `buildCorpsAppearances(db)`
  - `buildEventSeasonOptions(db)`, `buildEventCompetitionResolution(db)`
  - `buildRecaps(db)`, `buildJudges(db)`, `buildLatestPredictions(db)`
- The services then have two modes:
  - **read-model mode** (default in prod): trivially `SELECT * FROM rm_*`.
  - **live mode** (dev / emit / fallback): call the shared builder against the
    big DB. Same code the emitter uses → no drift.

> This is the single most important design decision: **builders are the source of
> truth; the emitter persists their output; services prefer the persisted output
> and fall back to the builder.** Drift becomes impossible by construction.

### Bulk-ify the per-slug queries
Live code fetches schedule/appearances/season-options per slug. The emitter must
produce them for **all** slugs in one pass. Two options per builder:
- Rewrite the CTE to drop the `WHERE event_slug = ?` and `GROUP BY`/window over
  all rows (fine at build time — the 114 ms full-table cost is now paid once), or
- Loop slugs in JS calling the existing single-slug builder (simpler, still fast
  at ~1.4k events / ~700 corps). Prefer the loop first; optimize only if slow.

### Emit performance — the per-row loops ARE the cost (measured)
**Status (2026-06-08):** the loop-first emitter works and is parity-clean, but a
full emit runs **~470 s**. The cost is entirely N+1 query loops over the 3.4 GB
source — not the row writes (the report stamps ~1.4k events, ~11.5k schedule
rows, etc. in seconds once gathered). Profiled hot loops, worst first:

1. **`about_text` per event** (`buildEventAbout` × 1,418) — the single dominant
   cost. Each hits `event_page_scrapes` with an `ORDER BY scraped_at DESC LIMIT 1`
   over a large archive table; nothing is written to the temp DB until all 1,418
   complete (why the `.tmp` looks frozen at ~2 MB mid-build).
2. **`competition resolution` per (season, slug)** (`buildCompetitionSlugForSeasonEvent`
   × ~1,224) — each call re-runs the full `eventSeriesCandidates` UNION scan.
3. **`season options` per distinct slug** (`buildEventSeasonOptions`) — same
   `eventSeriesCandidates` scan, re-run per slug.
4. **per-corps detail / season-points / appearances** (× ~125) and **per-judge
   profile** (× 243) — cheaper, but still one round-trip each.

**Planned fixes (do before wiring emit into ingest, §7):**
- **Batch `about_text` into one grouped query:** a single
  `SELECT event_slug, about_text … (window: row_number() OVER (PARTITION BY
  event_slug ORDER BY scraped_at DESC)) WHERE rn = 1`, loaded into a
  `Map<slug, text>` once. Expected to remove the bulk of the 470 s. Add a
  `buildAllEventAbouts(db)` builder beside `buildEventAbout` (keep the single-slug
  one for the live fallback).
- **Compute `eventSeriesCandidates` ONCE** and pass the rows into the season-option
  and competition-resolution builders (add bulk variants
  `buildAllEventSeasonOptions` / `buildAllCompetitionResolutions` that take the
  pre-fetched candidate set), instead of re-scanning per slug.
- **Keep the live single-slug builders** as-is for service fallback; the bulk
  builders are emit-only and must be parity-checked against the singles (§11) so
  they can't drift.
- Lower priority: wrap each section's reads in a single transaction / `Promise.all`
  with bounded concurrency. Only after the two scans above are de-N+1'd.

Until then the emit is a slow-but-correct batch step run a few times a season, so
this is an optimization, not a correctness gate.

**Update (2026-06-08): DONE — emit is now ~46 s (was ~470 s, 8.5×).** Added
`buildAllEventAbouts` (one windowed query → `Map<slug,text>`) and exported
`buildEventSeriesCandidates` so the emitter fetches the candidate set once and
passes it into `buildEventSeasonOptions` / `buildCompetitionSlugForSeasonEvent`
(live single-slug calls still self-fetch). Parity unchanged (1822 checks, 0
failures) — output byte-identical.

### Swap-while-server-running (two real findings)
1. **Windows can't replace a held-open file.** A running `node .output/server`
   holds `read-model.db` open, so the emit's `unlink`/rename of the target fails
   with `EBUSY`. The Linux deploy target allows rename-over-open (POSIX), so this
   is a Windows-dev caveat. The emitter now **degrades gracefully**: on persistent
   `EBUSY` it leaves the fresh, parity-clean build at `read-model.db.staging` and
   warns instead of failing ingest (swap it in after stopping the holder).
2. **Long-lived server client caches the old file (all OSes).** Each service
   caches its libsql client to `read-model.db` (`getReadDb`), so even a successful
   rename-swap won't be seen until the client reconnects. The "re-emit after
   in-app refresh updates served data" flow (§7) therefore needs the server to
   **reset its read-model client after a re-emit** (drop the cached client, or
   watch `rm_meta.built_at`/file mtime and reconnect). **Follow-up, not yet done.**

### Idempotency & safety
- **Never** call `ensureRelationalSchema` or anything with `DROP`/`DELETE`
  against the source (see AGENTS.md hazard). `@libsql/client` does **not** accept a
  read-only open flag for local files (`?mode=ro` throws `URL_PARAM_NOT_SUPPORTED`),
  so the read-only guarantee is **by discipline**: the emitter issues only
  `SELECT`s against the source. Enforced by code review, not the driver.
- Target is always a brand-new temp file → atomic rename. A failed emit leaves
  the previous `read-model.db` intact. **Windows note:** the libsql handle can
  linger briefly after `close()`, so checkpoint the WAL
  (`PRAGMA wal_checkpoint(TRUNCATE)`) before close and retry the temp→final
  rename through transient `EBUSY`/`EPERM`.
- `--dry-run`: run all builders + guardrails, print the report and row counts,
  write nothing.

### CLI
```
npx tsx scripts/emitReadModel.ts \
  [--source sdk/dci-relational.db] \
  [--out sdk/read-model.db] \
  [--dry-run] [--only events,corps,recaps,judges,predictions] \
  [--json-snapshot app/public/read-model/]   # tier-2 export (see §9)
```

---

## 6. Data-cleaning & edge cases (the hard part — enumerated)

Each becomes a **build-time concern**, logged in the emit report. Categorized by
where it already lives so nothing is lost.

### Already-encoded heuristics to preserve verbatim
- **Exclusion-pattern classification** (`domain_event_exclusion_patterns`):
  category priority `schedule_item < not_a_corps < alumni < exhibition < model`,
  tie-broken by `length(pattern) DESC, pattern`. Preserve the exact `row_number()`
  ranking. (42 patterns total.)
- **`all_times_present`**: null OR `trim(time)=''` OR `upper(time) LIKE '%TBD%'`
  ⇒ not all present. Keep exactly.
- **`is_alumni`**: `alumni` patterns OR `type LIKE '%alumni%'`, **except** name =
  `legacy drum & bugle corps`. Keep the exception.
- **Corps name normalization** (`normalizeCorpsName`): strips
  the/and/drum/bugle/corps + non-alphanumerics. **Display vs data:** normalization
  is for grouping only — never overwrite `corps.division_name` (ML feature; see
  AGENTS.md). Read-model carries normalized keys *alongside* originals.
- **Event text normalization** (`normalizeEventText`) + `knownSeriesKey`
  (`dcitourpremier`, `nightbeat`) + `eventCandidateScore` weighting (event +4,
  same-season +4, cinema −5, season-prefixed slug +2, has-competition +2,
  real city +1). Freeze the winners into `rm_event_season_options`.
- **Caption key normalization** (`normalizeCaptionKey` → GE1/GE2/VP/VA/CG/MB/MA/MP)
  and GE/Visual/Music subtotal math. Freeze into `rm_event_recap.scores_json`.
- **Venue dedup**: one row per event via `MIN(venue_id)` (name+address from the
  same row). Keep.
- **Competition-slug fallback chain**: `event_to_competition.competition_slug`
  → `competitions.slug` match → raw slug. Keep, materialize into
  `rm_event_competition_resolution` + `rm_events.competition_slug`.
- **Alias merge tie-break** (`rowCompleteness`: slug 16, logo 8, city 4,
  active/performing 2, division 1) and bidirectional alias resolution. Freeze
  into `rm_corps` (merged) + `rm_corps_alias_map`.
- **Season-score hiatus guard**: only emit a timeline point if the org has real
  `scored_event_lineup` presence that season (kills stale future-event preds for
  hiatus corps). Keep.
- **Uncertainty band**: `margin = 1.5 + 2.5 * (1 − clamp(percent_through,0,100)/100)`,
  rounded. Freeze `low`/`high`.
- **Latest-season rollover** (`current_season = MAX(season) with lineups`):
  the read-model is rebuilt each ingest, so this is naturally re-evaluated.
  Record the resolved `current_season` in `rm_meta` for transparency.

### Edge cases to handle explicitly in the emitter
- **Slug collisions across seasons** — key events by `event_id`, not `slug`
  (already the all-events convention). `rm_events.slug` is non-unique; lookups
  that need a single row must disambiguate by season (mirror
  `eventBySeasonAndSlug`'s prefixed/unprefixed slug logic and freeze results).
- **Empty / missing data** — events with no lineup/competition/scores must still
  emit a row with zero counts (LEFT JOIN semantics → `COALESCE(...,0)`), exactly
  as the live `COALESCE` does. Don't drop rows.
- **COVID seasons (2020/2021)** and **2025+ API gaps** (AGENTS.md) — sparse /
  atypical data; the builders already tolerate nulls. Emit report should flag
  seasons with anomalous counts but must not fail.
- **Corps appearing at a 2026 event with blank/non-standard division** — the
  directory deliberately includes them via `performing`. Preserve the
  `OR pc.corps_key IS NOT NULL` widening.
- **Duplicate caption rows** (multiple judges) — `caption_scores` is
  pre-aggregated; keep "first key wins" behavior.
- **Predictions saved but stale** — emit only snapshots `summary_json` of the
  latest saved run (no freshness recompute, no hydration). The live
  `getOrCreate` freshness/regeneration path is unchanged and still hits the big
  DB on explicit refresh.
- **about_text** — latest non-empty by `scraped_at`; often logistical, may be
  null. Emit as-is.

### Guardrails (read the `dq_*` views; warn, don't silently corrupt)
At emit time, query each `dq_*` view and include counts in the build report:
`dq_caption_total_mismatches`, `dq_duplicate_score_entries`,
`dq_invalid_caption_scores`, `dq_missing_caption_panels`, `dq_rank_inversions`,
`dq_showcase_rows`, `dq_unknown_judges`, `dq_zero_scores`.
- Default: **warn** (counts in report), still emit.
- `--strict`: fail the emit if any guardrail exceeds a configured threshold
  (use in CI / before publishing a client-shipped snapshot).
- Never auto-"fix" curated data in the emitter (AGENTS.md: don't overwrite
  curated data blindly). Cleaning belongs upstream in ingest; the emitter only
  reports.

---

## 7. Ingest pipeline integration

- Add `emitReadModel.ts` as the **final step** of `seasonUpdateWorkflow.ts`
  (after corps scrape, lineup ingest, backfills, ML). Skippable via
  `--skip-read-model` (mirrors `--skip-corps`/`--skip-ml`).
- Also runnable standalone (it only reads the source), so the read-model can be
  rebuilt without re-scraping — important because the source schema is the
  authority and rebuilds are cheap.
- After the in-app refresh (`spawnRefreshInBackground` /
  `refresh2026Events` in `event-directory.ts`) completes, trigger an emit so the
  UI reflects new data. (The refresh already runs `seasonUpdateWorkflow`; just
  drop `--skip-read-model`.)
- Record `source_db_mtime` + `ingest_commit` in `rm_meta` so the server can log
  which read-model it loaded and detect staleness.

---

## 8. App rewiring (server-side, tier 1 — the big win)

Per service, add a data-source switch keyed on `READ_MODEL_DB_URL`:

```ts
// shape per service
const READ_MODEL = process.env.READ_MODEL_DB_URL; // e.g. file:.../read-model.db
const getReadDb  = () => (rmDb ??= createClient({ url: READ_MODEL! }));

const listAllEventsFast = (db) =>
  Effect.tryPromise(() => db.execute('SELECT ... FROM rm_events ORDER BY ...'));

// service method:
list2026Events = Effect.fn(...)(function* () {
  return READ_MODEL
    ? yield* withReadDb((db) => listSeasonFromReadModel(db, '2026'))   // lookup
    : yield* withDb((db) => buildAllEventsRows(db));                    // builder
});
```

- **No Fate/transport/route changes.** Loaders keep calling the same service
  accessors; only the SQL underneath changes.
- Keep the **builder fallback** so dev without a read-model still works and the
  emitter and services share one definition.
- Bump caching now that data is static:
  - per-route `staleTime` high (historical seasons effectively `Infinity`;
    current season e.g. 5–10 min or tie to `rm_meta.built_at`),
  - `defaultPreloadStaleTime` off `0` in `router.tsx`.
- Wire `READ_MODEL_DB_URL` in the Node deploy preset env.

**Acceptance for tier 1:** every page renders byte-identical output with
`READ_MODEL_DB_URL` set vs unset (see §11), and read latency drops to lookup
speed (no CTEs, ~10 MB file).

---

## 9. Client-resident / offline (tier 2 — optional, after tier 1)

Two sub-options; pick per appetite. Tier 1 must ship first.

**9a. Static JSON snapshot + service worker (recommended first)**
- Emit step writes `app/public/read-model/*.json` (or a single gzipped bundle):
  `events.json`, `corps.json`, `recaps/<competition>.json`, etc. Whole thing is
  <1 MB gzipped.
- A service worker (or TanStack Start's static handling) caches the bundle;
  loaders read from it client-side when offline. SSR still uses the server
  read-model for first paint.
- Simplest; no WASM; true offline for browsed routes.

**9b. SQLite-WASM (only if client-side ad-hoc SQL is wanted)**
- Ship `read-model.db` (or a stripped subset) to the browser; query via
  `@libsql/client` web build or `wa-sqlite`/`sql.js`.
- Heavier bundle (~1 MB wasm) + more moving parts. Defer unless a real need
  (rich client filtering/joining) appears.

**Versioning:** `rm_meta.schema_version` doubles as the cache-bust key /
hydration scope. Bump it when the read-model schema changes incompatibly.

---

## 10. Fate SSR & SSE — honest placement

### SSR (`dehydrate`/`hydrate`)
- Fate supports it: server creates a request-scoped client, `await
  fate.request({...})`, `return { fate: fate.dehydrate() }`; client
  `fate.hydrate(loaderData.fate)` before render. Hydrated `cache-first` reads
  resolve from cache without refetching.
- **But:** every route except `fate-events.tsx` already SSRs via TanStack
  loaders → Effect services. So Fate SSR is **not** the speed lever; it only
  matters if/when more pages move onto Fate.
- **Recommendation:** keep loaders + Effect services as the read path (now backed
  by the read-model). Treat Fate as the pilot it is. If pursuing Fate further:
  - Wire `fate.dehydrate()` in the route loader and `fate.hydrate()` in
    `__root.tsx` so `fate-events.tsx` stops client-fetching on mount.
  - Caveats from Fate docs: dehydrate **after** awaited preload (no streaming of
    later-resolving data); hydrate before first render; hydration rejects clients
    with in-flight requests; snapshots are per-request (don't share across users);
    set/rotate `hydrationScope` on incompatible schema changes.
  - First resolve the pre-existing vinxi/build breakage noted in AGENTS.md (Fate
    HTTP round-trip is unverified until then).

### SSE / live views
- Fate's `/api/fate/live` is a **mutation-push** channel: subscribe to records,
  server pushes when you emit `live.update('Type', id)`. It is **not** a bulk
  backfill / "stream the rest of the data" mechanism.
- For static data there is nothing to push → **do not** use live views for the
  general site (one idle SSE connection per client for zero updates).
- **The one legitimate use:** live competition nights — when scores drop in real
  time, overlay `live.update` on *just the active event* atop the static
  read-model. Scope it to that feature; not part of this plan's core.
- "Stream extra data after load" (the original idea) doesn't need SSE: at this
  data size, request it all during SSR/loader, or fire one extra normal request
  after mount. No streaming protocol warranted.

---

## 11. Verification & testing

- **Parity harness** (the key safety net): a script that, for a representative
  set of slugs (and the full directory), runs the **builder against the big DB**
  and the **read-model lookup** and asserts deep-equality of the service output.
  Run in CI on every emit. This guarantees "no behavior change."
- **Golden snapshots**: serialize a sample of each page payload pre-change;
  diff after pointing at the read-model.
- **Performance check**: measure loader time for events directory, corps detail,
  prediction (cache-read) before/after. Confirm the CTE/big-file cost is gone.
- **Emit report assertions**: row counts within expected bounds; `dq_*` guardrail
  counts logged; `--strict` in CI.
- **Type-check**: `npm run check` for `app/`; `npx tsc -p tsconfig.json` for
  `sdk/` (diff against baseline per AGENTS.md — don't chase pre-existing errors).
- **User confirms UI** (per saved preference [[confirm-by-asking-not-browser]]):
  don't auto-launch a browser to verify; report results and let the user check.

---

## 12. Phased rollout

**Phase 0 — Extract builders (no behavior change).**
Move the SQL + JS post-processing from `app/lib/*` into shared builder modules
importable by both app and SDK. Services call builders (still hitting the big
DB). Ship; confirm parity. *This de-risks everything after.*

**Phase 1 — Emitter + read-model schema.**
Write `emitReadModel.ts`, the `rm_*` schema, `rm_meta`, atomic temp+rename,
`--dry-run`, build report + `dq_*` guardrails. Generate a read-model locally.

**Phase 2 — Parity harness.**
Builder-vs-read-model deep-equality across all slugs + directory. Make it CI.

**Phase 3 — Server reads from read-model.**
Add `READ_MODEL_DB_URL` switch + read-model lookups (builder fallback retained)
to each service. Bump `staleTime`/`defaultPreloadStaleTime`. Confirm parity +
perf. **Tier-1 win lands here.**

**Phase 4 — Ingest integration.**
Hook emit into `seasonUpdateWorkflow` (final step, `--skip-read-model`),
trigger after in-app refresh, stamp provenance.

**Phase 5 — Offline (in scope, JSON).**
Service worker with runtime caching (StaleWhileRevalidate for JSON, doc/asset
caching), keyed on `meta.json` version. Scope: pages seen or intent-preloaded
(§0.1.4). The per-detail JSON files emitted in Phase 1 are the offline payload.

**Phase 6 — Fate, layered on the read-model.** After Phases 0–4 and after the
vinxi/build breakage is fixed (hard gate): point `app/fate/sources.ts` at the
read-model-backed services, wire `dehydrate`/`hydrate` (loader → `__root.tsx`),
and migrate pages onto Fate one at a time — starting where cross-page entity
reuse pays off (corps shared across directory/detail/prediction). Flagship
follow-on: **live competition-night scores** via `useLiveView`/`live.update`.
Durable offline remains the SW-cached JSON from Phase 5 (Fate's cache is
in-memory).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Query drift between live & emit | Phase 0 shared builders; parity harness in CI |
| Source DB corruption during emit | Open source **read-only**; never call schema-ensure / DROP / DELETE |
| Serving a half-written read-model | Write temp file + atomic rename; server keeps old file until swap |
| Stale read-model after ingest | Emit is the final ingest step; `rm_meta` provenance + staleness log |
| Hidden per-request freshness logic (predictions) | Only snapshot the *read* shape; leave `getOrCreate` generation path untouched |
| Curated data silently mangled | Emitter reports `dq_*`, never auto-fixes; cleaning stays upstream |
| Schema desync (relational.ts older than DB) | Builders read live DB schema, not `relational.ts` (AGENTS.md) |
| Big-DB-only fields needed later | Builder fallback path stays; can widen `rm_*` and re-emit cheaply |

---

## 14. Open questions — RESOLVED (2026-06-06, see §0.1)

1. **Read-model format:** ✅ **libSQL `read-model.db` on the backend** + **JSON
   for the client/offline tier**, both emitted from the same builders.
2. **Where do builders live:** ✅ `sdk/src/readModel/builders/*` (reachable by
   both the emitter and the app via `@sdk/...`).
3. **Current-season caching:** ✅ **1 day** `staleTime`; historical `Infinity`;
   emit-after-refresh busts sooner via `meta.json` version.
4. **Offline scope:** ✅ **pages seen or intent-preloaded** — SW runtime cache
   (StaleWhileRevalidate), not full precache.
5. **Fate:** ✅ **Retained**, layered on the read-model (its source adapter reads
   `read-model.db`), sequenced **after** Phases 0–4; durable offline still via SW
   JSON (Fate's cache is in-memory). Gate: fix the vinxi/build breakage first.
