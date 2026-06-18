# SDK Migration Plan: Life After api.dci.org

> **Context:** The public DCI API (`api.dci.org`) was decommissioned in May 2026. It no longer resolves in DNS. The SDK must be rearchitected to survive without it. This plan covers what to change, in what order, and why.

---

## 1. Current State Assessment

### What Is Broken

- `api.dci.org` → DNS `NXDOMAIN`. Every SDK method that calls it fails with `DciNetworkError`.
- `sdk/src/client.ts` hardcodes `https://api.dci.org/api/v1` in `defaultConfig`.
- `sdk/src/runtime.ts` reads `DCI_API_BASE_URL` from env; even if overridden, no replacement JSON API exists.
- `ingestRelationalData`, `scrapeAllData`, and `seasonUpdateWorkflow` all call `api.getSeasons()`, `api.getCompetitions()`, `api.getCorps()`, etc. — every one of these now throws.

### What Still Works

- **Website scraping:** `scrapeEventPages.ts`, `scrapeWebsiteRecaps.ts`, `ingestLineupsFromScrapes.ts` use `www.dci.org` and are unaffected.
- **Cached API data:** `api_responses` table has ~1,000 cached responses:
  - 984 recaps, 106 competition lists, 17 event lists, 8 galleries, etc.
  - `ingestRelationalDataFromApiResponses` can still parse these.
- **Wayback Machine:** Archived snapshots of the old API still exist and can be fetched.
- **Existing relational tables:** `competitions` (through 2025), `events` (through 2026 via new scraper), `corps`, etc. are populated.

### What We Discovered

The DCI website uses WordPress AJAX at `admin-ajax.php` to power its event schedule and scores pages. Reverse-engineered actions:

| Action                 | Data                             | Status                                                     |
| ---------------------- | -------------------------------- | ---------------------------------------------------------- |
| `load_events`          | Event schedule cards (HTML)      | **Working** — 80 events found for 2026                     |
| `score_events`         | Scored competition list (HTML)   | **Season-dependent** — empty for 2026 until scores release |
| `grid_events`          | Event grid view (HTML)           | Discovered, not wired                                      |
| `print_events`         | Print-friendly event list (HTML) | Discovered, not wired                                      |
| `get_calendar_content` | Calendar widget (HTML)           | Discovered, not wired                                      |
| `get_event_data`       | Mobile event list (HTML)         | Discovered, not wired                                      |

---

## 2. Data Source Matrix

For each data type the SDK needs, here is the new preferred source and fallback chain:

| Data Type                                                         | Preferred Source                                   | Fallback 1                             | Fallback 2                 |
| ----------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- | -------------------------- |
| **Events (2026+)**                                                | `admin-ajax.php?action=load_events` (HTML scrape)  | Existing `events` table                | Wayback API snapshots      |
| **Competitions (2026+)**                                          | `admin-ajax.php?action=score_events` (HTML scrape) | Existing `competitions` table          | Website final-scores pages |
| **Recaps / Scores**                                               | Website recap pages (`/scores/recap/<slug>/`)      | Cached `api_responses` (pre-2026)      | Wayback API snapshots      |
| **Corps list**                                                    | Existing `corps` table                             | Cached `api_responses["corps"]`        | Wayback API snapshots      |
| **Performance classes**                                           | Existing `performance_classes` table               | Cached `api_responses["performances"]` | Hardcoded static list      |
| **Event lineups**                                                 | `scrapeEventPages.ts` (`/events/<slug>/`)          | Existing `event_lineup_entries`        | —                          |
| **Judge breakdowns**                                              | Website recap pages                                | Cached `api_responses["recap"]`        | —                          |
| **Seasons list**                                                  | Existing `competitions.season` DISTINCT values     | Cached `api_responses["seasons"]`      | Hardcoded 2013–2026        |
| **Rankings / Totals**                                             | Website recap pages                                | Cached `api_responses["recap"]`        | —                          |
| **Auxiliary** (sponsors, galleries, past champions, page content) | Existing DB tables                                 | Cached `api_responses`                 | —                          |

> **Key insight:** For everything pre-2026, the cached API data in `api_responses` plus existing relational tables is sufficient. For 2026+, we need new scrapers for events and competitions. Recaps will always come from website scraping.

---

## 3. High-Level Architecture Changes

### 3.1. Make the API Client Gracefully Degrade

The `DciApi` service (`sdk/src/service.ts`) should not crash the whole pipeline when the API is unreachable. Instead, it should return empty results and log warnings, allowing the caller to fall back to cached/scraped data.

**Option A (recommended):** Add a `fallbackMode` to `DciSdkConfig`:

- `"live"` (default, old behavior) — try API, fail hard on error.
- `"cache-first"` — try API, but if it fails with `DciNetworkError`, silently return empty results and log a warning. The caller is expected to have cached data or use scrapers.
- `"offline"` — never call the API; always return empty results.

**Option B:** Keep `DciApi` as-is but wrap every call site in `Effect.catchAll` that returns empty defaults. This is more invasive.

### 3.2. Introduce a `DciWebsiteApi` Service

Create a new Effect service that wraps the `admin-ajax.php` endpoints. This keeps the website AJAX logic separate from the legacy API client.

```typescript
// Proposed new service
export interface DciWebsiteApi {
  readonly loadEvents: (options?: {
    page?: number;
    filters?: EventFilters;
  }) => Effect<EventListResponse, DciError>;
  readonly loadAllEvents: () => Stream.Stream<EventCard, DciError>;
  readonly scoreEvents: (options?: {
    season?: string;
    page?: number;
  }) => Effect<ScoreListResponse, DciError>;
  readonly loadAllScoreEvents: (season: string) => Stream.Stream<CompetitionSummary, DciError>;
}
```

### 3.3. Update `ingestRelationalData` to Be Source-Aware

The main ingest function should:

1. **Skip live API calls** for 2026+ (or any season where `api.dci.org` is known dead).
2. **Bootstrap events** via `ingestEventsFromWebsite.ts` before running the rest of the pipeline.
3. **Ingest competitions** from `score_events` AJAX once the season starts.
4. **Preserve historical path** for pre-2026 seasons using cached API data.

---

## 4. Detailed Change List (By File)

### Phase 1: Stop the Bleeding (Immediate)

These changes make the existing workflows run without crashing.

#### `sdk/src/config.ts`

- Add `fallbackMode: "live" | "cache-first" | "offline"` to `DciSdkConfig`.
- Default to `"cache-first"` for resilience.

#### `sdk/src/client.ts`

- In `buildRequest`, if `fetch` fails with a network error and `config.fallbackMode !== "live"`, return an empty `Response` (or a synthetic 503) instead of throwing `DciNetworkError`.
- Alternatively, add `Effect.catchAll` wrappers in `makeDciApi` for every public method so that API failures return empty arrays/maps instead of crashing.

#### `sdk/src/relational.ts` — `ingestRelationalData`

- Wrap each auxiliary ingest call (`api.getCorps()`, `api.getEvents()`, etc.) in `Effect.catchAll` that logs the error and continues.
- For `scrapeAllData` call inside `ingestRelationalData`, add a guard: if `api.getSeasons()` fails, use `options.seasons` or skip the warm phase entirely.

#### `sdk/scripts/seasonUpdateWorkflow.ts`

- Default `skipApi` to `true` for season ≥ 2026, or make the API phase conditional on whether `api.dci.org` resolves.
- Add a pre-flight check: run `ingestEventsFromWebsite.ts` if the `events` table has < 10 rows for the target season.

### Phase 2: Build the New Scrapers (Short-Term)

#### `sdk/src/websiteApi.ts` (new file)

- Implement `DciWebsiteApi` service.
- `loadEvents`: POST to `admin-ajax.php`, parse HTML with `cheerio`, return structured event cards.
- `scoreEvents`: POST to `admin-ajax.php`, parse HTML rows, return competition summaries with slug, name, date, location, scores link.
- Handle pagination (follow `data-page` links or iterate `page` param until empty).
- Extract WordPress nonce from `www.dci.org/events` page HTML when needed for `score_events`.

#### `sdk/scripts/ingestEventsFromWebsite.ts`

- **Already written and working.** Keep as-is. Potentially move the core parsing logic into `websiteApi.ts` so it can be reused.

#### `sdk/scripts/ingestCompetitionsFromWebsite.ts` (new file)

- Call `DciWebsiteApi.scoreEvents` for the target season.
- Parse HTML rows to extract:
  - `name` (from `.h6.fg-primary-100`)
  - `date` (from date cell)
  - `location` (from location cell)
  - `scores_link` (from "View scores" `href`)
  - Derive `slug` from the scores link URL.
- Upsert into `competitions` table with minimal metadata (slug, name, date, season).
- Once recaps are released, the existing `scrapeWebsiteRecaps.ts` will fill in the full score details.

#### `sdk/src/relational.ts` — `ingestSeason` updates

- If `api.getCompetitions(season)` returns empty and season ≥ 2026, try `DciWebsiteApi.scoreEvents` as a secondary source.
- If both are empty, log a warning and skip the season (this is expected pre-season).

### Phase 3: Historical Data Preservation (Short-Term)

#### `sdk/scripts/migrateApiCache.ts` (new file, optional)

- If we ever need to rebuild the DB from scratch, this script would:
  1. Read all `api_responses` rows.
  2. Call `ingestRelationalDataFromApiResponses` to repopulate relational tables.
  3. Run `reingestFromCache.ts` to restore website recaps.
- This is an insurance policy against DB corruption or migration.

#### `sdk/scripts/verifyDataCompleteness.ts` (new file, optional)

- Audit script that checks each season for:
  - Expected competition count vs actual.
  - Expected recap count vs actual.
  - Missing slugs that exist in `api_responses` but not in relational tables.
- Useful for detecting gaps after the API is gone.

### Phase 4: Refactor the Client Abstraction (Medium-Term)

#### `sdk/src/client.ts` — Split into `DciLegacyApiClient` and `DciUnifiedClient`

- `DciLegacyApiClient`: the current `api.dci.org` client, preserved for historical use and Wayback fallback.
- `DciUnifiedClient`: a new higher-level client that orchestrates across sources:
  - For pre-2026: uses cached API data or Wayback.
  - For 2026+: uses `DciWebsiteApi` + website scrapers.
  - Always prefers relational DB cache when available.

This is a bigger refactor. It may not be necessary if the Phase 1/2 changes are sufficient for the 2026 season.

### Phase 5: Documentation & Observability (Ongoing)

#### `sdk/docs/dci-api.md`

- **Already updated.** Keep current.

#### `sdk/docs/dci-website-scraping.md`

- **Already updated.** Keep current.

#### `sdk/docs/ingest-scrape-data-generation.md`

- **Already updated.** Keep current.

#### `AGENTS.md`

- Should be updated to reflect the new reality:
  - Replace references to "DCI API is the source of truth" with "Website scrapers + cached data are the source of truth for 2026+".
  - Note that `api.dci.org` is decommissioned.

#### Observability

- Add metrics for:
  - API fallback events (how many times we skipped the API and used cache/scrapers).
  - Website AJAX parse failures (HTML structure changes).
  - Data freshness per season (last updated timestamp per table).

---

## 5. Execution Priority

### Priority 1: This Week (Before 2026 Season Starts)

1. ✅ ~~`ingestEventsFromWebsite.ts` — bootstrap 2026 events~~ (DONE)
2. **Make `ingestRelationalData` resilient:** Wrap all `api.*` calls in `catchAll` so failures don't crash the pipeline. This unblocks `seasonUpdateWorkflow` with `--skip-api`.
3. **Update `seasonUpdateWorkflow`:** Default to `--skip-api` for 2026, or auto-detect API unavailability and skip gracefully.
4. **Update `AGENTS.md`** to document the API decommissioning.

### Priority 2: Before First 2026 Competition

5. **Build `ingestCompetitionsFromWebsite.ts`:** Parse `score_events` HTML into `competitions` rows.
6. **Wire `DciWebsiteApi` into `ingestSeason`:** If `api.getCompetitions` returns empty for 2026+, try `scoreEvents`.
7. **Test end-to-end:** Run a dry-run `seasonUpdateWorkflow` for a historical season (e.g., 2025) using only cached data + website scrapers to verify the pipeline still produces correct output.

### Priority 3: During 2026 Season (Ongoing)

8. **Monitor `score_events`:** Once scores release, verify that `score_events` HTML structure matches our parser. Be prepared to update selectors if DCI changes the page layout.
9. **Monitor `load_events`:** Same concern — if DCI redesigns the event cards, `cheerio` selectors will need updates.
10. **Build data completeness audit:** Run `verifyDataCompleteness.ts` weekly to catch missing competitions or recaps.

### Priority 4: Nice-to-Have (Post-Season)

11. **Refactor to `DciUnifiedClient`:** Clean separation between legacy API client and new website client.
12. **Add `fallbackMode` config:** Make the SDK configurable for offline/air-gapped environments.
13. **Investigate `dci.org` GraphQL or REST v2:** DCI may launch a new API. If so, build a new client for it.

---

## 6. Testing Strategy

### Unit Tests (for new scrapers)

- Save sample HTML responses from `load_events` and `score_events` as fixtures.
- Test `cheerio` parsing against these fixtures.
- Test pagination logic (empty page = stop).

### Integration Tests (for the pipeline)

- Run `ingestEventsFromWebsite.ts --season=2026` and assert `events` count ≥ 70.
- Run `seasonUpdateWorkflow.ts --season 2026 --skip-api --dry-run` and verify it does not crash.
- For a historical season (e.g., 2024), run `ingestRelationalData` with `--skip-api` and assert the output counts match the cached-data baseline.

### Regression Tests

- Ensure `reingestFromCache.ts` still works for pre-2026 seasons.
- Ensure `scrapeWebsiteRecaps.ts` still parses recap pages correctly.

---

## 7. Risks and Mitigations

| Risk                                                 | Likelihood | Impact | Mitigation                                                                                                                |
| ---------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| DCI changes website HTML structure                   | Medium     | High   | Keep HTML fixtures; update selectors quickly; add fallbacks (try multiple selectors)                                      |
| `score_events` requires a new nonce or auth          | Low        | High   | Extract nonce dynamically from the event page HTML before each request                                                    |
| Wayback Machine blocks or rate-limits us             | Medium     | Medium | Respect rate limits; prime availability cache once per month; use local cache first                                       |
| Cached API data in `api_responses` is lost/corrupted | Low        | High   | Keep `dci-relational.old.db` as backup; run `ingestRelationalDataFromApiResponses` periodically to verify integrity       |
| No live corps list source exists                     | High       | Medium | The existing `corps` table is fairly static; accept that new corps (if any) will need manual entry or event-page scraping |
| Performance: HTML scraping is slower than JSON API   | Medium     | Low    | Use concurrency (3–5 parallel requests); cache aggressively; only scrape what's needed                                    |

---

## 8. Summary: What to Do Right Now

If you want to make the SDK functional for 2026 today:

1. **Bootstrap events:**

   ```bash
   cd sdk
   npx tsx scripts/ingestEventsFromWebsite.ts --season=2026
   ```

   ✅ Already done — 80 events inserted.

2. **Make the pipeline resilient:**
   - Edit `sdk/src/relational.ts`: wrap `api.getCorps()`, `api.getEvents()`, `api.getPerformanceClasses()`, etc. in `Effect.catchAll` that logs and continues.
   - Edit `sdk/src/relational.ts`: in `ingestSeason`, if `api.getCompetitions(season)` fails, return gracefully instead of crashing.

3. **Update the workflow:**
   - Edit `sdk/scripts/seasonUpdateWorkflow.ts`: auto-set `--skip-api` for season ≥ 2026.

4. **Run the workflow:**

   ```bash
   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-05-26 --skip-api --skip-recaps
   ```

   This will scrape event pages for lineups and rebuild ML artifacts without touching the dead API.

5. **Build the competition scraper** (once the season starts):
   - Implement `sdk/src/websiteApi.ts`.
   - Implement `sdk/scripts/ingestCompetitionsFromWebsite.ts`.
   - Wire it into `ingestSeason` as a fallback.

That's it. The rest of the plan is about making the SDK robust, maintainable, and future-proof — but the above five steps will get you through the 2026 season.
