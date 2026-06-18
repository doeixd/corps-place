# DCI API Guide

> **Status Update (May 2026):** The public DCI API at `api.dci.org` has been **fully decommissioned** and no longer resolves in DNS. The SDK now provides **three interchangeable DciApi layers** plus a **composite orchestrator**:
>
> 1. **Network** (`client.ts`) — Legacy `api.dci.org`. Dead.
> 2. **DB-backed** (`dbBackedApi.ts`) — Reads from SQLite relational tables. **Production default.**
> 3. **Website scraper** (`websiteApi.ts`) — Hybrid: tries `admin-ajax.php`, then falls back to direct HTML page scraping.
> 4. **Composite** (`compositeApi.ts`) — Tries sources in order (DB → website → network) and silently skips failed/empty ones.

## Base URL

- **Legacy (decommissioned):** `https://api.dci.org/api/v1`
  - No longer resolves. All direct API calls fail with `DciNetworkError` / DNS `NXDOMAIN`.
- **Replacement (live):** `https://www.dci.org/wp-admin/admin-ajax.php`
  - WordPress AJAX endpoint used by the dci.org frontend. Discovered by reverse-engineering `custom-events.js`.

## What Happened to api.dci.org

- **DNS failure:** `api.dci.org` returns `NXDOMAIN`.
- **Redirects on root domain:** `https://dci.org/api/v1/<path>` 301-redirects to `http://www.dci.org/api/v1/<path>`, which then 301-redirects to generic WordPress HTML pages (e.g., `/corps/`). No JSON API responses are served.
- **Impact:** All SDK namespaces that relied on direct API calls (`seasons`, `competitions`, `recaps`, `corps`, `events`, `galleries`, `performances`, `pageContent`, `sponsors`, `pastChampions`) now fail.

## Reverse-Engineered AJAX Endpoints

The DCI website uses `admin-ajax.php` to power its event schedule and scores pages. The following actions were discovered by analyzing `sdk/scripts/custom-events.js` and confirmed with `curl`.

### `load_events` — Upcoming Event Schedule

- **Method:** `POST`
- **URL:** `https://www.dci.org/wp-admin/admin-ajax.php`
- **Body (form-encoded):**
  - `action=load_events`
  - `page=<number>` (1-based)
  - `filters[corps]=` (optional)
  - `filters[location_state]=` (optional)
  - `filters[start_date]=` (optional, `YYYY-MM-DD`)
  - `filters[end_date]=` (optional, `YYYY-MM-DD`)
- **Response:** JSON `{ html: "...", pagination: "..." }`
  - `html` contains event cards with date, location, time, event name, slug, ticket links, and event images.
  - `pagination` contains current/total page counts and next/prev links.
- **Total pages:** For 2026 season, 8 pages of 10 events each (80 total events).
- **Rate limiting:** None observed, but polite delays (500ms) are used between pages.

### `score_events` — Scored Competitions

- **Method:** `POST`
- **URL:** `https://www.dci.org/wp-admin/admin-ajax.php`
- **Body (form-encoded):**
  - `action=score_events`
  - `nonce=<wp_nonce>` (required; sourced from page HTML)
  - `post_type=competition`
  - `posts_per_page=10`
  - `paged=<number>`
  - `filter_season=<year>` (optional)
  - `filter_location=` (optional)
- **Response:** JSON `{ success: true, data: { content: "...HTML...", current_page: 2, total_pages: 106 } }`
  - `content` is HTML rows with competition name, date, location, and a "View scores" link.
- **Current status for 2026:** Returns `"No score found."` because the season has not started. Once scores are released, this endpoint will populate.

### Other Actions (from JS analysis)

- `grid_events` — Grid view of events (same filters as `load_events`).
- `print_events` — Print-friendly event list.
- `get_calendar_content` — Calendar widget HTML.
- `get_event_data` — Mobile event list for a specific date.

**Note:** These are not yet wired into the SDK; they are documented here for future use if needed.

## Legacy API Endpoints (Archived)

The following endpoints were part of the now-dead `api.dci.org` API. They are preserved here for reference when working with cached data or Wayback snapshots.

- `GET /competitions/seasons` — Seasons list.
- `GET /competitions?season=<year>` — Competition metadata.
- `GET /competitions/<slug>` — Recap data (totals, placements).
- `GET /corps` — Corps profiles.
- `GET /events?season=<year>` — Event metadata.
- `GET /events/corps?sort=name` — Reference corps list.
- `GET /events/regions`, `GET /events/states` — Reference lists.
- `GET /competitions/locations` — Reference locations.
- `GET /galleries` — Gallery metadata.
- `GET /performances`, `GET /performances/corps`, `GET /performances/classes` — Performance history.
- `GET /page-content`, `GET /sponsors`, `GET /past-champions` — Auxiliary content.

## How We Use the Data Now

- **Composite layer (default):** Queries DB first; if DB returns empty, tries website scraper; if website fails, tries network API.
- **Events:** Bootstrapped via `sdk/scripts/ingestEventsFromWebsite.ts` (one-shot AJAX script), then served from DB by the composite layer.
- **Competitions:** For 2026, no competitions exist yet. Once the season starts, `score_events` will populate the DB via the website scraper, and the composite layer will serve them.
- **Corps:** No live corps list API is currently available. The existing `corps` table (from historical API cache or Wayback ingest) is used as-is.
- **Recaps:** Website recap scraping (`sdk/src/scrapeWebsiteRecaps.ts`) and individual recap page scraping (`websiteApi.ts`) remain the primary sources for judge/subcaption breakdowns.

## New Bootstrap Script: `ingestEventsFromWebsite.ts`

A dedicated script was written to seed the `events` table without the dead API.

- **File:** `sdk/scripts/ingestEventsFromWebsite.ts`
- **Usage:** `npx tsx scripts/ingestEventsFromWebsite.ts --season=2026`
- **What it does:**
  1. POSTs to `admin-ajax.php?action=load_events` for each page.
  2. Parses HTML with `cheerio` to extract:
     - `slug` (from event detail URL)
     - `name` (event title)
     - `startDate` (parsed from "26 Jun" format into `YYYY-MM-DD`)
     - `locationCity` / `locationState` (from "Muncie, IN")
     - `webStartTime` (from "8:00 PM ET")
     - `buyTicketsLink`, `watchLiveLink`, `eventImage`
  3. Upserts rows into `events` with a synthetic `event_id` of `web-<season>-<slug>`.
- **Result:** Successfully inserted 80 events for 2026 season on first run.

## Pagination and Caching

### Legacy API

- Paginated via `x-pagination-page-count` headers.
- Cached in `api_responses` table.

### Website AJAX

- Paginated via `page` parameter; total pages found in `pagination` HTML snippet.
- No built-in caching yet; the script fetches live each time. The resulting rows are stored in the `events` table, which acts as the cache.

## Limitations and Gotchas

- **api.dci.org is dead:** Any script or workflow that calls the legacy `makeDciApiLayer()` with the default `baseUrl` will fail entirely. The new default is `makeCompositeDciApiLayer()` which prefers DB/website over network.
- **Website scraper hybrid behavior:** The scraper tries `admin-ajax.php` first, then falls back to direct HTML page scraping. AJAX works for a few requests before DCI's WordPress firewall blocks it (403). Direct HTML scraping works for server-rendered pages (individual recaps, event details) but NOT for JS-dependent lists (`/events/` and `/scores/` load cards via AJAX).
- **No structured JSON for events:** The `load_events` response is HTML, not JSON. Parsing is dependent on CSS selectors (`.upcoming-events-box`, `.upcoming-events-info`, etc.) and may break if the site redesigns.
- **No corps list endpoint:** There is currently no known replacement for `GET /corps`. Rely on existing DB data or Wayback snapshots.
- **Scores not yet available:** `score_events` for 2026 returns empty HTML until the first competitions are scored.
- **Nonce requirement:** `score_events` requires a WordPress nonce extracted from the event page HTML. It may expire; the scraper should fetch a fresh nonce if requests fail.
- **COVID seasons (2020–2021):** Data remains sparse and inconsistent regardless of source.

## Wayback Fallback

Wayback Machine snapshots of the old API are still valuable for historical data:

- `sdk/scripts/scrapeWaybackApi.ts` fetches archived API snapshots.
- `sdk/scripts/scrapeWaybackEvents.ts` and `sdk/scripts/ingestWaybackEvents.ts` populate historical event data.
- `sdk/scripts/primeWaybackApiAvailability.ts` preloads known snapshot URLs.

This is especially important because the new AJAX endpoints do not expose historical competition/recap data in a structured format.

## Data Flow into the DB (Updated)

- **Events (new):** `admin-ajax.php?action=load_events` → parsed HTML → `events` table via `ingestEventsFromWebsite.ts`.
- **Events (historical):** Wayback API snapshots → `api_responses` → `events` / `event_schedules` / `event_group_types`.
- **Competitions (historical):** Cached API responses → `competitions` + related tables.
- **Recaps:** Website recap pages → `website_recaps.raw_html` → `corps_scores`, `caption_scores`, `judge_scores`, `subcaption_scores`.
- **Corps:** Existing `corps` table (from historical API cache or Wayback); no live source currently available.
- **Auxiliary:** Historical cache only (`galleries`, `sponsors`, `page_content`, `past_champions`).

## When to Prefer What Source

| Data                          | Preferred Source                    | Fallback                           |
| ----------------------------- | ----------------------------------- | ---------------------------------- |
| 2026+ Events                  | `ingestEventsFromWebsite.ts` (AJAX) | Wayback API snapshots              |
| 2026+ Competitions            | `score_events` AJAX (once live)     | Website final-scores / recap pages |
| Totals / Placements           | Website recap pages                 | Cached API data (pre-2026)         |
| Judge / Subcaption breakdowns | Website recap pages                 | N/A                                |
| Corps list                    | Existing DB cache                   | Wayback API snapshots              |
| Legacy event metadata         | Wayback API snapshots               | N/A                                |

## Recommended Workflow for 2026+

1. **Bootstrap events (one-shot before firewall blocks):**
   ```bash
   npx tsx scripts/ingestEventsFromWebsite.ts --season=2026
   ```
2. **Scrape event pages for lineups:**
   ```bash
   npx tsx scripts/scrapeEventPages.ts --season=2026
   npx tsx scripts/ingestLineupsFromScrapes.ts
   ```
3. **Run season update (composite layer handles DB + website automatically):**
   ```bash
   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-05-26
   ```
   No `--skip-api` needed anymore. The composite layer reads from DB by default and silently falls back to website scraping if needed.
4. **Once scores release:** The composite layer will automatically find new competitions via `score_events` or HTML fallback and populate `competitions`.

## Bypassing Cloudflare with Browserbase

Since May 2026, DCI.org is behind Cloudflare. Direct Node.js `fetch()` returns a challenge page. To scrape new pages live, use the **Browserbase integration**:

```typescript
import { makeWebsiteScraperWithBrowserbaseLayer } from '@corps-place/sdk';
import { BrowserbaseServiceLive } from '@corps-place/sdk';

// Set BROWSERBASE_API_KEY in environment, then:
const apiLayer = makeWebsiteScraperWithBrowserbaseLayer();
```

Or manually wire it:

```typescript
import { makeWebsiteScraperDciApiLayer, BrowserbaseServiceLive } from '@corps-place/sdk';
import { Layer } from 'effect';

const apiLayer = makeWebsiteScraperDciApiLayer().pipe(Layer.provide(BrowserbaseServiceLive));
```

When Browserbase is provided, the website scraper routes all HTTP fetches through Browserbase's managed browser, bypassing Cloudflare automatically.
