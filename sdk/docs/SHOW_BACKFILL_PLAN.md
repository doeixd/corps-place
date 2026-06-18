# Show Backfill Plan (2013–2025) — DCX Museum historical repertoire

Status: **Draft / proposed** — awaiting approval before implementation.
Last updated: 2026-06-10

## 1. Why

`corps_shows` (and its children `corps_show_repertoire` / `_designers` / `_movements`
/ `_media` / `_reviews` / `_tags`) currently holds **2026 only** (81 rows, 34 real
titles). The prediction lineup and any "what did this corps perform" view have no
historical program titles / repertoire before this season.

We want to **backfill show titles, descriptions, and repertoire (with composers)
for every season 2013–2025.**

## 2. What already exists (reuse, don't rebuild)

| Component | File | Notes |
| --- | --- | --- |
| Show orchestrator (4 sources) | `src/showOrchestrator.ts` | `runDcxIngestion` / `runFloMarchingIngestion` / `runAgentIngestion` / `runDciOrgIngestion`. We add a 5th: `runDcxHistoryIngestion`. |
| DCX scraper | `src/showScraperDcx.ts` | `scrapeAll()` parses the **current-year** roster page only (`option=current`). Pure parser `parseDcxRepertoireHtml`. We add `scrapeRepYear` + `parseRepYearHtml`. |
| Ingestion service | `src/showIngestion.ts` | `upsertShow` / `upsertDesigners` / `upsertMovements` / `archiveScrape`. Reuse as-is. |
| Archive table | `show_announcement_scrapes` | PK `(corps_key, source_url, scraped_at)`; year lives in `source_url` so multiple years coexist. Mirror the archive-first pattern. |
| Name matching | `normalizeCorpsName` (`showOrchestrator.ts`) | Fuzzy `normalizedName → corps_key` map, already used by DCX ingest. |
| Builders / read-model | `src/readModel/builders/shows.ts` | `buildAllShowTitles` already emits **all** seasons → `rm_show_titles`. Backfilled rows surface automatically after a re-emit. No builder change. |
| Driver | `scripts/ingestShowAnnouncements.ts` | `--apply` / `--season` / `--source`. Extend with a season **range** and `dcx-history` source. |

## 3. Recon findings (live, plain `fetch` — DCX is NOT behind Cloudflare)

- The roster page (`index.cfm?roomid=302&view=repertoires&option=current`) is
  **current-year only**. `option=<year>` is **ignored** (returns identical bytes).
- The corps detail page (`index.cfm?view=corpslist&corpsid=<id>&corpsyear=<year>`)
  loads repertoire via an AJAX endpoint:
  ```
  https://www.dcxmuseum.org/Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=<id>&CorpsYear=<year>
  ```
  Verified live (HTTP 200, no challenge). For a competing year it returns:
  - **Show title** — `<div class="blue-bg">…</div>` (e.g. "Magnum Opus").
  - **Repertoire** — `<tr><td><a …Song=…>Title</a> <strong>by</strong> <a …Composer=…>Composer</a></td></tr>` rows, with composers.
  - **Final championship result** — `Position:` and `Score:` (often `0.000` placeholder for older/incomplete years).
  - For a non-competing year: a clean `Repertoire unavailable` block → skip.
- `CorpsID` is **stable across years**. We already have it for **70 / 81** 2026 shows
  in `metadata_json.dcxCorpsId`.
- ⚠️ Parser note: `blue-bg` divs may repeat — the **first** is the show title;
  subsequent ones are **movement headers**. Parse accordingly (title = first
  blue-bg; later blue-bg = movement boundaries, optional).

## 4. Approach & principles

1. **Archive-first.** Persist raw `Corpslist_RepYear.cfm` HTML into
   `show_announcement_scrapes` (`source_type='dcx_repyear'`, year encoded in
   `source_url`) before parsing. Parsing is a pure, re-runnable function.
2. **Free + polite.** DCX is unauthenticated and Cloudflare-free → plain `fetch`,
   no Browserbase. Sequential with a small delay + retry/backoff; cache by skipping
   corpsid×year pairs already archived unless `--refresh`.
3. **Coalescing, dry-run-first.** Upsert by `corps_key`; never null existing data;
   `--apply` gates writes. Default dry-run reports would-be changes.
4. **Scope = all mappable DCX corps.** Seed corpsids from 2026 `dcxCorpsId`
   metadata, then fuzzy-match the full current DCX roster (`parseDcxRepertoireHtml`
   already yields `{dcxCorpsId, dcxCorpsName}`) against `corps.name` via
   `normalizeCorpsName`. Iterate mapped corpsids × years 2013–2025; `Repertoire
   unavailable` years cost one cheap fetch and are skipped.

## 5. Components (proposed)

- **`parseRepYearHtml(html) → { title, placement, score, repertoire: {workTitle, composer}[] }`**
  (pure, cheerio) in `showScraperDcx.ts`; `unavailable` → returns `null`.
- **`DcxScraper.scrapeRepYear(corpsId, year)`** — fetch + archive-aware (skip if
  fresh archive exists unless `--refresh`) → parse.
- **`buildShowFromDcxHistory(parsed, corpsKey, year)`** — `CorpsShow` with real
  title, repertoire incl. composers; placement/score → `metadata_json`.
- **`ShowOrchestrator.runDcxHistoryIngestion({ seasons })`** — build corpsid→key
  map, loop corpsids × seasons, upsert (coalescing), return per-(corps,year) result.
- **Driver**: `ingestShowAnnouncements.ts` gains `--source dcx-history` and a
  `--season 2013-2025` range form. Dry-run prints coverage (corps×years matched,
  titles found, repertoire counts); `--apply` writes.

## 6. Milestones

- **M1 — Parser + fixtures. ✅ DONE.** `parseRepYearHtml` (`showScraperDcx.ts`) +
  `test/showScraperRepYear.test.ts` (20/20) over fixtures in `test/fixtures/dcx/`
  (competing year w/ composers, real placement+score, `unavailable` year, edge).
  **Finding:** the multi-movement worry was unfounded — RepYear lists songs flat
  with exactly one `blue-bg` title per year; no movement headers to disambiguate.
- **M2 — Scraper + archive. ✅ DONE.** `DcxScraper.scrapeRepYear(corpsId, year)`
  returns `{ url, html, httpStatus, result }`; archive-first + skip-fresh live in
  the orchestrator (queries `show_announcement_scrapes` by `source_url`).
- **M3 — corpsid→key map. ✅ DONE.** Seeds from `corps_shows.metadata_json`
  (`dcxCorpsId`, any season) + fuzzy-matches the live DCX roster via
  `normalizeCorpsName`. Smoke run mapped **82 corps**.
- **M4 — Orchestrator + dry-run. ✅ DONE.** `ShowOrchestrator.runDcxHistoryIngestion`
  + driver `--source dcx-history --season 2013-2025` (range) / `--refresh`. Dry-run
  fetches + reports without writing. **2024 dry-run:** 82 fetched, 70 real titles,
  12 unavailable, 0 errors.
- **M5 — Apply + re-emit. ✅ DONE (2026-06-12).** Ran `--apply` across 2013–2025:
  696 `dcx_repyear` shows persisted (2013–2025, 47–81/season) with 3,273 repertoire
  rows. Idempotent re-run confirmed (skip-fresh: 696, written: 0; the 370 newly
  fetched older-year pairs were genuinely `unavailable`). Full `emitReadModel.ts`
  re-emit published live (pointer flipped, no restart) → `rm_show_titles: 664`.

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| DCX markup varies by era (older years sparser) | Archive-first → re-parse; defensive parser; fixtures across eras. |
| Corps that competed historically but aren't in current roster/DB | Out of scope per decision (only mappable corpsids); unmatched logged for later. |
| Composer/arranger format inconsistency | Capture composer from the `Composer=` link; stash raw row in `metadata_json` so nothing's lost. |
| Overwriting curated 2026 / future data | Backfill targets historical seasons; coalescing + dry-run; never null. |
| DCX rate limiting | Sequential + delay + retry/backoff; skip already-archived pairs. |

## 8. Out of scope

- Corps with no mappable DCX `CorpsID` (logged for a later alias pass).
- FloMarching / DCI.org / agent enrichment for historical years (DCX-only here).
- Designers/staff for historical years (DCX RepYear doesn't carry them).
