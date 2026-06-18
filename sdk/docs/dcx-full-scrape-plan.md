# DCX Museum — Full-Site Scrape Plan (standalone `dcx.db`)

Status: **Proposed** · Last updated: 2026-06-15
Goal: scrape **all structured/text data** from `dcxmuseum.org` into a **new,
standalone SQLite DB** (`sdk/dcx.db`) we can query independently of the main
`dci-relational.db`.

**Scope decision (locked):** *everything except media bytes* — capture every
text/structured field and asset **metadata/captions + image URLs**, but do **not**
download image files. **Normalized tables only** (no raw-HTML archive table).

Follows `sdk/docs/web-research-and-scraping-field-guide.md`.

---

## 1. The site (as mapped)

ColdFusion app: `index.cfm?roomid=<R>&view=<V>&option=<O>`. **No Cloudflare** —
plain `fetch`/curl with a generic UA works. `robots.txt` is `Disallow: /` (it's a
volunteer archive): scrape **politely** — low concurrency (≤2), throttled, a
descriptive UA, resumable, cache-friendly.

### Room / view map
| Room | Views (option) | Notes |
|---|---|---|
| 100 Corps | `corps` lists: all/active/international/allgirl/junior/senior/soundsport/drumline/military/parade/alumni/minicorps/state | each row → `view=corpslist&corpsid=N` |
| 200 Shows | `shows` current/byyear/major; `assets` video/recordings | |
| 300 Season | `shows` calendar/thisyear/summary; `repertoires` current; `photos` current | repertoires already handled by existing scraper |
| 700 Photos | `photos` recent/photographer/historical/current/season | image galleries (metadata + URLs only) |
| 800 People | `people` members/halloffame/interviews/biographies/collection/contributor/donors; `assets` photosofpeople | |
| 900/1200 Memorabilia | ~25 `assets` rooms: jackets, hats, buttons, pennants, flags, pins, tshirts, programbooks, posters, yearbooks, patches, paintings, podcasts, … | gallery: `assets/<CODE>-.jpg` thumbnails + captions |
| 1100 Publications | DCW, DCN, history books, newspapers; `bookcase`; `PublicationList` | |
| 1300 Decades | `decade` browse 1300–1311 | navigational; likely redundant with corps/shows |

### The corps-detail hub — `index.cfm?view=corpslist&corpsid=<N>`
- **~14,490 corps IDs** total (`roomid=101&option=all`). This is the bulk.
- One ~280 KB fetch returns **all 7 tabs inline** (Bootstrap `.tab-pane`
  `#tab-1..7`; the `tab=` query param does not change server output — tabs are
  client-side). Tab labels:
  1. **Repertoire** 2. **Photos** 3. **History** 4. **Scores** 5. **Members**
  6. **Collections** 7. **Links**
- Tables render as `.footable`/`.table.table-bordered` → cheerio row parsing.
- Per-year repertoire detail (composers, placement, score) lives at
  `Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=<N>&CorpsYear=<Y>` (existing
  `parseRepYearHtml` already handles this).

---

## 2. Strategy

**Corps-first crawl.** The corpslist hub yields History + Repertoire + Scores +
Members + Photos + Collections + Links in a single fetch — so one pass over the
~14.5k corps IDs captures the majority of the structured data. Then sweep the
standalone rooms (People, Shows, memorabilia/asset galleries, Publications) for
the data not reachable from a corps.

**Discovery → enqueue tasks → durable queue → worker pool fetch/parse/upsert.**
Deterministic cheerio parsing (field guide Pattern A); **no LLM** — the markup is
regular tables. Everything runs in **Effect** end-to-end (service layers, typed
errors, `Effect.forEach` concurrency, `Schedule` backoff).

### Durable work queue (stop/restart safe)
The single requirement that shapes the runtime: **we must be able to kill the
process at any point and resume without losing or re-doing work.** A status-only
table (like the main repo's `scraper_progress`) gates idempotency but doesn't
model *in-flight* work — a crash mid-task leaves no record it was claimed. So we
use a **SQLite-backed claimable queue** in `dcx.db` (durable = it survives
restarts because it *is* on disk):

- **Enqueue** is idempotent: `INSERT OR IGNORE` by `task_key`. Re-running the
  orchestrator re-enqueues nothing already present (done/pending alike).
- **Claim** is atomic: a single `UPDATE … WHERE status='pending' OR (status='claimed'
  AND lease_expires_at < now) ORDER BY priority, enqueued_at LIMIT 1 RETURNING *`
  (libsql supports `UPDATE … RETURNING`). The lease makes a **crashed worker's**
  task automatically reclaimable once its lease expires — no manual cleanup.
- **Complete / fail:** on success → `status='done'`; on transient error →
  requeue (`status='pending'`, `attempts++`) with `Schedule.exponential` backoff
  until `max_attempts`, then `status='failed'` with `last_error`. Parse-empty →
  `status='empty'` (honest gap, not retried).
- **Worker pool:** N Effect fibers (N = `--concurrency`, default 2) each loop
  *claim → process → settle*; the pool drains when no claimable rows remain.
  `Effect.forEach(workers, …, { concurrency: N })` + `Effect.repeat` per worker.
- **Restart:** just relaunch `scrapeDcx.ts` — pending rows resume, expired-lease
  (crashed) rows get reclaimed, `done`/`empty` rows are skipped. No flags needed.

**Politeness:** concurrency ≤2, ~300–500 ms jitter between requests, descriptive
UA (e.g. `dcx-archive-mirror/1.0 (contact: <email>)`), resumable so we never
re-hammer completed IDs. A full corps pass ≈ 14.5k fetches → run as a throttled
background job over hours, not a burst.

---

## 3. `sdk/dcx.db` — normalized schema (draft)

Library: `@effect/sql-libsql` (`LibsqlClient.layer({url:"file:./dcx.db"})`),
matching the repo. All IDs are DCX's own numeric IDs where available.

```sql
-- Durable work queue (claimable, lease-based; survives stop/restart)
CREATE TABLE scrape_queue (
  task_key   TEXT PRIMARY KEY,      -- e.g. 'corps:17', 'repyear:17:2024', 'asset-room:jackets'
  task_type  TEXT NOT NULL,         -- corps|repyear|people|asset-room|shows|publications
  params_json TEXT,                 -- task-specific args (corpsId, year, room option, …)
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending|claimed|done|empty|failed
  priority   INTEGER NOT NULL DEFAULT 100,     -- lower = sooner (enumerate before detail)
  attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  worker_id  TEXT,                  -- which fiber holds the lease
  lease_expires_at INTEGER,         -- epoch ms; expired claim → reclaimable after crash
  http_status INTEGER,
  last_error TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_queue_claimable ON scrape_queue (status, priority, enqueued_at);

-- 100 Corps
CREATE TABLE corps (
  dcx_corps_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nickname TEXT, city TEXT, state TEXT, country TEXT,
  founded TEXT, disbanded TEXT,
  division TEXT, class TEXT, circuit TEXT,
  categories_json TEXT,            -- which lists it appeared in (junior/senior/allgirl/…)
  history_text TEXT,               -- tab-3 narrative
  source_url TEXT, scraped_at INTEGER
);

-- tab-1 / RepYear: one row per (corps, year, work)
CREATE TABLE corps_repertoire (
  dcx_corps_id TEXT NOT NULL, year INTEGER,
  ordinal INTEGER,
  show_title TEXT, work_title TEXT, composer TEXT, arranger TEXT,
  source_url TEXT,
  PRIMARY KEY (dcx_corps_id, year, ordinal)
);

-- tab-4 Scores: one row per (corps, year, event)
CREATE TABLE corps_scores (
  dcx_corps_id TEXT NOT NULL, year INTEGER,
  event_date TEXT, event_name TEXT, location TEXT,
  placement INTEGER, score REAL, class TEXT,
  source_url TEXT,
  PRIMARY KEY (dcx_corps_id, year, event_name, event_date)
);

-- tab-5 Members (DCX "members" = associated people)
CREATE TABLE corps_members (
  dcx_corps_id TEXT NOT NULL,
  person_id TEXT,                  -- DCX person id if linked
  name TEXT NOT NULL, role TEXT, years TEXT,
  source_url TEXT,
  PRIMARY KEY (dcx_corps_id, name, role, years)
);

-- 800 People (room 801–808)
CREATE TABLE people (
  dcx_person_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,                   -- halloffame|biography|interview|contributor|donor|member
  bio_text TEXT, photo_url TEXT,
  source_url TEXT, scraped_at INTEGER
);

-- 700 Photos + tab-2 corps photos + 807 people photos
CREATE TABLE photos (
  photo_id TEXT PRIMARY KEY,       -- derived from image filename/url
  image_url TEXT NOT NULL, thumb_url TEXT,
  caption TEXT, year INTEGER, photographer TEXT,
  owner_type TEXT, owner_id TEXT,  -- corps|person|show|room
  source_url TEXT
);

-- 900/1200 Memorabilia (one table, room/option = category)
CREATE TABLE assets (
  asset_code TEXT PRIMARY KEY,     -- e.g. JA0001
  category TEXT NOT NULL,          -- jackets|hats|buttons|… (the room option)
  caption TEXT, year INTEGER,
  corps_name TEXT, dcx_corps_id TEXT,
  image_url TEXT, thumb_url TEXT,
  source_url TEXT
);

-- 200 Shows
CREATE TABLE shows (
  show_id TEXT PRIMARY KEY,
  year INTEGER, title TEXT, corps_name TEXT, dcx_corps_id TEXT,
  kind TEXT,                       -- major|byyear|current
  source_url TEXT
);

-- 1100 Publications
CREATE TABLE publications (
  pub_id TEXT PRIMARY KEY,
  collection TEXT,                 -- dcw|dcn|historybooks|newspaper|bookcase|…
  title TEXT, issue TEXT, year INTEGER,
  image_url TEXT, source_url TEXT
);
```

Indexes on the FK-ish columns (`dcx_corps_id`, `year`, `owner_id`, `category`).
Schema is a **draft** — finalize each table after dumping one real page per room
into a fixture and confirming columns.

---

## 4. Architecture / files

- **`sdk/src/dcxScrape/`** (new module dir)
  - `dcxClient.ts` — throttled fetch `Effect` (generic UA, jitter, retry via
    `Schedule`), reusable across all parsers.
  - `dcxQueue.ts` — the durable queue as an Effect service: `enqueue(task)`
    (`INSERT OR IGNORE`), `claim(workerId)` (atomic `UPDATE … RETURNING`),
    `complete`/`fail`/`markEmpty`, `reclaimExpired()`, and `runWorkers(n, handler)`
    (the fiber pool). Backed by `dcx.db`, so it is durable across restarts.
  - `dcxDb.ts` — schema DDL + coalescing upserts per table. Queue DDL lives here too.
  - `parseCorps.ts` — parse the 7-tab corpslist page → {corps, repertoire[],
    scores[], members[], photos[], collections[], links[]}. Reuse
    `parseRepYearHtml` from `showScraperDcx.ts` for per-year detail.
  - `parsePeople.ts`, `parseAssets.ts`, `parsePhotos.ts`, `parseShows.ts`,
    `parsePublications.ts` — one per room family.
  - `enumerate.ts` — list pages → ID lists (corps, people, asset codes, pub ids).
- **`sdk/scripts/scrapeDcx.ts`** — CLI orchestrator (one Effect program):
  enqueues enumerate/detail tasks then starts the worker pool.
  `--rooms corps,people,assets,shows,photos,publications` (default all),
  `--ids 17,34` / `--limit N` / `--concurrency 2` / `--db dcx.db`. **No `--resume`
  flag needed** — relaunching always drains the durable queue from where it left
  off. `--reset` to requeue `failed`, `--status` to print queue counts.
- **Tests/fixtures:** save one HTML dump per room family
  (`renderHtml.ts`/curl → `sdk/test/fixtures/dcx/<room>.html`) and unit-test each
  parser (extend the existing `showScraperDcx.test.ts` pattern).

---

## 4a. Implementation status (2026-06-15)

- ✅ **M0** — fixtures saved (`test/fixtures/dcx/`: corps-detail, people-halloffame,
  people-biographies, assets-jackets, shows-byyear, publications-dcw).
- ✅ **M1** — `dcxDb.ts` (schema + coalescing upserts), `dcxQueue.ts` (durable
  queue + worker pool), `dcxClient.ts` (throttled polite fetch), `scrapeDcx.ts`
  CLI. Restart test green (`test/dcxQueue.restart.test.ts`): crash mid-drain →
  reclaim → resume, no loss, at-least-once.
- ✅ **Corps pass (M2 core)** — `parseCorps.ts` (all 7 tabs) + `enumerate.ts`
  wired end-to-end. Validated on real corps 17/25/34 → 156 repertoire, 161
  scores, 490 members, 117 photo-groups; re-run is an idempotent no-op.
  Parser test: `test/parseCorpsDetail.test.ts` (36 assertions vs. the real page).
- ✅ **Assets + publications** — `parseAssets.ts` handles both gallery types
  (memorabilia + DCW), dedupes alternate-view images. Test: `test/parseAssets.test.ts`.
- ✅ **Shows byyear (room 200)** — `parseShows.ts`: 74 shows from the real fixture
  with date/event/location/showId + 668-entry corps lineup. *(Earlier "JS-loaded"
  worry was wrong — the content is server-rendered as `ul.list-group` blocks; no
  render ladder needed.)*
- ✅ **People (room 800)** — `parsePeople.ts`: `biographies` (PDF cards → title/
  url/contributor) and the `halloffame` *index* (links to wdchof/dcihof/bughof/…
  sub-pages). Test: `test/parseShowsPeople.test.ts`. HOF member rows live on the
  sub-pages (next: follow those `view=*hof` links).
- ✅ **All handlers wired into `scrapeDcx.ts`** — task types: `corps`, `repyear`,
  `asset-room` (25 rooms), `shows`, `bios`, `hof-index`→`hof-page`. `--rooms`
  selects families (default all); `--repyear` opts into per-year backfill.
  Upserts added for every table.
- ✅ **HOF sub-pages** — they're prose articles, not member rows; captured as
  `hof_pages` (title + body_text). The index fans out to each `view=*hof` page.
- ✅ **RepYear backfill (item 3)** — `corps` handler fans out `repyear:<id>:<year>`
  tasks; `parseRepYearHtml` fills composer + show_title + placement/score.
- ✅ **Full field coverage** — corps now also captures status/division/class/logo/
  links/tab-6 assets; assets capture collection+contributor provenance.
- ✅ **End-to-end verified** (corps 17/25 + all rooms): 559 repertoire (552 w/
  composer), 102 placed scores, 398 members, 463 assets (41 w/ contributor), 74
  shows + 668 lineup, 6 corps links, 5 HOF pages, 2 bios.
- ✅ **Asset-room pagination** — galleries show 20/page; `assets.cfm` embeds an
  `AssetPage[]` array of per-page id chunks; each chunk loads via
  `assets_display.cfm?roomid=&option=&assetlist=<ids>` (bare GET 500s — needs the
  roomid/option context). The `asset-room` task now discovers chunks and fans out
  one durable `asset-page` task per page. Cards also carry the **owning corps**
  link (corpsId+name) → captured. Verified live: full asset sweep = 627 page tasks,
  0 failed, **7,014 assets** (was 20/room) — 5,273 corps-linked, 1,513 with
  contributor. (Per-asset `--2` alternate views dedupe to one `asset_code`.)
- ✅ **Room-700 photos** — `parsePhotos.ts`: photo rooms render photo *groups*
  inline (year + count + representative thumb + `PhotoShowModal` params; no
  pagination). `photo-room` task per room. Verified live: 87 historical groups
  (~18k photos indexed), 26 season, 5 photographer. Per scope we index the groups,
  not individual image bytes.
- ◻️ **Remaining:** the full ~14.5k corps enumerate run (throttled background) +
  post-run verification counts. Every page family now has a tested parser +
  wired handler.

## 5. Milestones

- **M0 — Fixtures & schema lock.** Dump one real page per room (corps detail,
  people, each asset category sample, shows, publications). Confirm columns; lock
  the schema above.
- **M1 — DB + durable queue + client.** `dcxDb.ts` DDL + upserts; `dcxQueue.ts`
  (enqueue/claim/complete/fail/reclaim + worker pool) with a **restart test**
  (enqueue N, kill mid-drain, relaunch → finishes exactly the remainder, no dupes);
  `dcxClient.ts` throttled fetch. `scrapeDcx.ts --init`/`--status`.
- **M2 — Corps pass.** `enumerate` corps IDs (~14.5k) + `parseCorps` (all 7 tabs)
  + RepYear backfill. Validate on ~20 corps, then throttled background full run.
- **M3 — People + Shows.** room 800 + room 200 parsers.
- **M4 — Memorabilia + Photos + Publications.** asset galleries (metadata + image
  URLs, no bytes), room 700, room 1100.
- **M5 — Verify & index.** row counts vs. site list counts; spot-check; add
  indexes; write a short `dcx.db` query README.

---

## 6. Invariants
1. **Politeness:** ≤2 concurrency, throttled, descriptive UA, resumable. Never
   burst the 14.5k corps.
2. **Idempotent/resumable:** the durable `scrape_queue` gates every task —
   `INSERT OR IGNORE` enqueue + lease-based claim. Killing the process at any
   point and relaunching resumes exactly where it stopped; crashed (expired-lease)
   tasks are auto-reclaimed; `done`/`empty` are skipped. Re-run is a no-op.
3. **Coalescing upserts:** a missing field never nulls an existing value.
4. **Provenance:** every row carries `source_url` (+ `scraped_at` where sensible).
5. **No media bytes** (scope): store image **URLs**, do not download files.
6. **Honest gaps:** record `empty`/`failed` in `scrape_progress`; never fabricate.
7. **Standalone:** `dcx.db` only — do not touch `dci-relational.db`. (A later,
   separate step can join DCX IDs into the main DB via `backfillDcxMuseumLinks`.)

---

## 7. Open questions
- Descriptive UA / contact string to use (politeness).
- Does the "Members" tab actually carry staff/role data worth normalizing, or is
  it login-gated member accounts? (Confirm on M0 — the members list linked to
  `corpslist&tab=5`, suggesting it's people-per-corps.)
- Are `decade` (1300) and some `shows` views redundant with corps data (skip to
  avoid double work)?
- History depth for scores/repertoire — take whatever the corps page lists (no
  artificial year floor).
```
