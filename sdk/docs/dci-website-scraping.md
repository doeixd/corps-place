# DCI Website Scraping Guide

This doc covers how we scrape DCI.org, known limitations, edge cases, and how to run/recover scrapes.

## What We Scrape

- **Recap pages** for judge/subcaption data and full recap breakdowns.
- **Final-scores pages** as an alternate entry point when recap URLs are unavailable.
- **Event pages** for lineup order / performance order data.
- **Event schedule AJAX** (`admin-ajax.php?action=load_events`) to bootstrap the `events` table now that `api.dci.org` is decommissioned.

## Data We Extract and How It’s Used

- **Recap pages** (`/scores/recap/<slug>/`)
  - Data: per‑corps totals, sub‑totals, penalties, ranks; judge captions (GE/Visual/Music) and subcaption breakdowns.
  - Stored: `website_recaps.raw_html` + `website_recaps.parsed_json`; normalized into `corps_scores`, `caption_scores`, `judge_scores`, `judge_assignments`, `subcaption_scores`.
  - Used for: judge/subcaption modeling, recap detail views, and filling gaps when API lacks breakdowns.

- **Final‑scores pages** (`/scores/final-scores/<slug>/`)
  - Data: links back to recap pages and summary totals.
  - Stored: only as a fetch entry point; recap data ultimately stored from the linked recap page.
  - Used for: fallback when recap URLs don’t resolve directly.

- **Event pages** (`/events/<slug>/`)
  - Data: lineup order, performance time, display city/unit names.
  - Stored: raw in `event_page_scrapes.lineup_json`; normalized into `event_participants` and `event_lineup_entries` with `performance_order`.
  - Used for: performance order features in ML and schedule views when API schedule data is missing.

## Source of Truth vs. Website Data

- The DCI API is the source of truth for competitions, corps, totals, and rankings.
- The website is scraped to recover **judge/subcaption breakdowns** and **performance order**, which the API no longer always provides.
- Starting in **2025**, API recap gaps increased, so website recaps are often required for full judge data.

## Key Endpoints (website)

- Recap page: `https://www.dci.org/scores/recap/<slug>/`
- Final scores page: `https://www.dci.org/scores/final-scores/<slug>/`
- Event page: `https://www.dci.org/events/<slug>/`
- Event schedule AJAX: `POST https://www.dci.org/wp-admin/admin-ajax.php`
  - `action=load_events` — upcoming event cards (HTML response)
  - `action=score_events` — scored competitions list (HTML response)

## AJAX-Based Event Schedule Scraping

Since `api.dci.org` was decommissioned, the live event schedule is now retrieved via WordPress AJAX.

### `load_events` Action

- **Request:** `POST /wp-admin/admin-ajax.php` with form body:
  - `action=load_events`
  - `page=1` (1-based pagination)
  - `filters[corps]=`, `filters[location_state]=`, `filters[start_date]=`, `filters[end_date]=`
- **Response:** JSON with two keys:
  - `html` — raw HTML string containing `.upcoming-events-box` cards.
  - `pagination` — HTML snippet with current page and total pages.
- **Parsing strategy:**
  - Each card is a `.upcoming-events-box` containing:
    - Event image: `.upcoming-events-img > img[src]`
    - Date: `.upcoming-events-contact li:nth-child(1) span` (e.g., `26 Jun`)
    - Location: `.upcoming-events-contact li:nth-child(2) span` (e.g., `Muncie, IN`)
    - Time: `.upcoming-events-contact li:nth-child(3) span` (e.g., `8:00 PM ET`)
    - Name & slug: `h4 a` (href contains `/events/<slug>/`)
    - Ticket link: `.upcoming-events-buy-tickets a.btn[href]`
    - Live stream link: `a[aria-label*="live stream"]`
  - The scraper parses the "26 Jun" text into `YYYY-MM-DD` using a hardcoded month map.
  - Location text is split on `,` to derive city and state.
- **Caching:** Successful page fetches are cached twice in `api_responses`:
  - raw response: `endpoint_type = load_events_raw`
  - parsed card payload: `endpoint_type = load_events_parsed`
- **Pagination caveat:** the server-rendered `/events/` HTML currently contains page 1 plus pagination metadata (`1 from 9`, `data-page="2"`), but not the later event cards. Later pages require the `load_events` AJAX POST. As of May 2026, direct Node/browser-session POSTs can be blocked by the DCI WordPress firewall, so a cold ingest may need Browserbase or an already-good `api_responses` cache.
- **Coverage:** current cached 2026 data has 81 event rows and 80 event-page scrape rows with lineup JSON.

### `score_events` Action

- **Request:** `POST /wp-admin/admin-ajax.php` with form body:
  - `action=score_events`
  - `nonce=<value>` (extracted from event page HTML — may expire)
  - `post_type=competition`
  - `posts_per_page=10`
  - `paged=1`
  - `filter_season=2026`
- **Response:** JSON `{ success: true, data: { content: "...HTML...", current_page, total_pages } }`
- **Current status:** Returns `"No score found."` for 2026 until the season starts.

### Script: `ingestEventsFromWebsite.ts`

- **File:** `sdk/scripts/ingestEventsFromWebsite.ts`
- **Usage:** `npx tsx scripts/ingestEventsFromWebsite.ts --season=2026`
- **Behavior:**
  1. Iterates through all pages of `load_events`.
  2. Parses HTML cards with `cheerio`.
  3. Caches successful raw and parsed page payloads in `api_responses`.
  4. Upserts rows into `events` with synthetic `event_id = web-<season>-<slug>`.
  5. Populates: `slug`, `name`, `event_name`, `season`, `year`, `start_date`, `location_city`, `location_state`, `web_start_time`, `buy_tickets`, `live_stream_link`, `event_image`, `event_image_thumb`.
- **Important:** This script creates synthetic `event_id`s because the WordPress response does not expose the old API's numeric/string event IDs. The `slug` remains the canonical identifier for joins.

## Event Slug Behavior (Important)

- Event slugs in `events.slug` are mixed format:
  - Some are already season-prefixed (example: `2019-dci-west`).
  - Many are base slugs reused across seasons (example: `dci-west`).
- `scrapeEventPages.ts` logs event attempts as `season:slug` when season is known (example: `2019:dci-west`) to avoid ambiguity.
- For event page fetches, scraper tries candidates in this order:
  1. `/events/<slug>`
  2. `/events/<season>-<slug>` (only when slug does not already start with `YYYY-`)
- If both live URLs 404, Wayback is attempted for both candidates before marking `not_found`.
- Canonical storage key remains the original DB slug (`event_page_scrapes.event_slug = events.slug`), so ingestion joins stay stable.

## Where Data Is Stored

- Raw recap HTML: `website_recaps.raw_html`
- Parsed recap JSON: `website_recaps.parsed_json`
- API cache: `api_responses.response_json`
- Event page scrapes: `event_page_scrapes.lineup_json`
- Wayback availability cache (event pages): `event_wayback_availability`
- Scrape failures: `website_scrape_failures`

## Scripts

- `sdk/src/scrapeWebsiteRecaps.ts`
  - Scrapes recap pages and ingests recap data into relational tables.
  - Ingests cached API responses first unless `--skipApiCache`.

- `sdk/src/reingestFromCache.ts`
  - Re-parses cached recap HTML and re-ingests without re-scraping.

- `sdk/scripts/ingestEventsFromWebsite.ts`
  - Bootstraps the `events` table from the live DCI website schedule via `admin-ajax.php?action=load_events`.
  - Parses HTML event cards into structured rows with synthetic `event_id`s.
  - Usage: `npx tsx scripts/ingestEventsFromWebsite.ts --season=2026`

- `sdk/scripts/scrapeEventPages.ts`
  - Scrapes event pages and stores lineup JSON.
  - Skips slugs that already exist in `event_page_scrapes` unless `--overwrite`.
  - Tries both slug forms (`<slug>`, `<season>-<slug>`) and caches Wayback found/missing results.
  - Options: `--overwrite`, `--refresh-wayback-cache`, `--refresh-wayback-missing`.

- `sdk/scripts/primeWaybackEventAvailability.ts`
  - Preloads `event_wayback_availability` from Wayback CDX for `/events/*` captures.
  - Used to speed up `scrapeEventPages.ts` by avoiding repeated Wayback availability checks.

- `sdk/scripts/primeWaybackApiAvailability.ts`
  - Preloads `api_wayback_availability` from Wayback CDX for `api.dci.org/api/v1/events*` captures.
  - Used by `ingestWaybackEvents.ts --fetch-current-year` to try cached snapshot URLs first.

- `sdk/scripts/ingestLineupsFromScrapes.ts`
  - Normalizes event page lineup JSON into `event_participants` / `event_lineup_entries`.

- `sdk/scripts/backfillEventVenues.ts`
  - Backfills `event_venues` from `events` + latest `event_page_scrapes` location fields.
  - Useful because many API/Wayback event payloads do not include nested `event.venue` objects.

## Known Edge Cases and Gotchas

- **Cloudflare block (May 2026+):** DCI.org is now behind Cloudflare. Direct `fetch()` from Node.js returns an "Attention Required" challenge page instead of actual HTML. This means the **live website scraper cannot fetch new recap pages or event pages** without browser automation. The scraper still works for:
  - **Previously cached HTML** in `website_recaps.raw_html` (re-parsed on demand)
  - **AJAX responses** cached in `api_responses` (if fetched before the block)
  - **Browserbase-automated fetches** (see below)
- **Website scraper caching:** The `websiteApi.ts` layer now caches successful responses:
  - AJAX (`load_events`, `score_events`) → `api_responses` table (7-day TTL)
  - `/events/` raw HTML and parsed first-page payloads → `api_responses` table (7-day TTL)
  - Recap HTML → `website_recaps` table (7-day TTL)
  - Future fetches check cache first before making live requests
- **Do not cache firewall bodies:** Firewall/challenge responses are not treated as successful event schedule data and should not replace previously good cache rows.
- **Browserbase bypass:** Set `BROWSERBASE_API_KEY` and use `makeWebsiteScraperWithBrowserbaseLayer()` to route all scraper fetches through Browserbase, bypassing Cloudflare. This is the recommended path for live scraping when Cloudflare is active.
- **Final-scores fallback**: Some final pages link to a recap page; use the recap link for the full breakdown.
- **Totals-only recaps**: Some pages only show total/subtotal/penalties with no GE/Visual/Music tables. We parse totals without judge breakdowns.
- **Class headers**:
  - Class section headers can be `All Age` (space) or `All-Age` (hyphen).
  - We match `World Class`, `Open Class`, `All Age`, `International`, `SoundSport`.
- **Penalties-only headers**: Some tables have `Penalties` as a header row; these are not captions and should not be ingested as judges.
- **Multiple .score-date-location blocks**: Use the block near the recap table, not the page header, for the recap date/location.
- **Missing recap page**: `final-scores` may exist even if `recap` does not; scrape the final page and then follow the recap link if present.
- **COVID seasons (2020–2021)**: limited and inconsistent coverage. Expect sparse recaps and missing event info.
- **2025+ API gaps**: API often lacks legacy recap/judge breakdowns; website scrape is required.

## Retry/Failure Behavior

- HTTP retries use exponential backoff (base 250ms, max 6 attempts).
- Recap failures are written to `website_scrape_failures` and the scrape continues.
- If you see 500/429 responses, rerun; cached HTML will prevent re-fetching where possible.

## Performance Order Notes

- Performance order comes from:
  - `event_schedules.performance_order` (API)
  - `event_page_scrapes.lineup_json` → `event_participants`/`event_lineup_entries` (website)
- ML queries use `COALESCE` across these and fall back to row_number if missing.

## Suggested Workflows

- **Full website recap ingest**:
  - `npx tsx src/scrapeWebsiteRecaps.ts --seasons 2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025`

- **Apply parser fixes without re-scraping**:
  - `npx tsx src/reingestFromCache.ts --seasons 2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025 --skip-api`

- **Refresh performance order**:
  - `npx tsx scripts/scrapeEventPages.ts --season=2024`
  - `npx tsx scripts/ingestLineupsFromScrapes.ts`
