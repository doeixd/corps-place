# Corps Website Scraping & Ingestion Plan

Status: **Draft / proposed** — awaiting approval before implementation.
Owner: TBD · Last updated: 2026-06-02

## 1. Why

The DCI **public JSON API (`api.dci.org/api/v1`) was removed.** That API was the
sole source that populated the rich `corps` table (name, class/division, about,
socials, logo/photo, website, address, contacts). Consequences observed in the
codebase today:

- `websiteApi.getCorps()` explicitly throws `"getCorps is not supported by the
website scraper API"` — it was always delegated to the network client.
- The network client (`makeDciApi` → `/corps`) now hits a dead endpoint.
- Therefore **there is currently no working source for corps data.** Existing
  `corps` rows are frozen at whatever the last API ingest captured, and classes
  (which change between/within seasons) cannot be refreshed.

Goal: **robustly scrape dci.org for all corps data, archive the raw responses,
parse everything we can, and ingest it** — replacing the dead API as the corps
source of truth, on a repeatable cadence.

## 2. What already exists (reuse, don't rebuild)

| Component                               | File                                                                                      | Notes                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browserbase fetch (bypasses Cloudflare) | `src/browserbaseService.ts`                                                               | `fetchHtml(url)` via `bb.fetchAPI.create`. Key in root `.env` (`BROWSERBASE_API_KEY`). Verified working below.                                                              |
| Website scraper API (admin-ajax)        | `src/websiteApi.ts` (1033 ln)                                                             | Scrapes `admin-ajax.php`; **caches every fetch in `api_responses`** with staleness checks; accepts an **injectable `fetchHtml`**. Does NOT implement corps.                 |
| Browserbase-wired website layer         | `runtime.ts` → `makeWebsiteScraperWithBrowserbaseLayer`                                   | Already injects `bb.fetchHtml` into the website scraper — but only in this standalone layer, not the default composite.                                                     |
| Composite layer (default)               | `runtime.ts` → `makeDciApiLayerFromConfig`                                                | Default sources `['db','website','network']`. Uses **direct fetch** (Cloudflare-blocked) and the **dead network** source.                                                   |
| Raw-HTML archive pattern                | `event_page_scrapes` table + `upsertEventPageScrape` (`relational.ts`)                    | The model to mirror: archive raw HTML/JSON + parsed columns, replayable, re-ingestable.                                                                                     |
| Corps table (rich target schema)        | `corps` (`relational.ts`)                                                                 | ~50 cols: about, description, website, corps_logo, corps_photo, address/city/state/zip/country, facebook/twitter/instagram/youtube/linked_in, contacts, division_name, etc. |
| Corps identity/normalization            | `normalizeCorpsNameForMatch`, `resolveExistingCorpsKey`, **`corps_aliases`** (just added) | Reuse for linking scraped corps to canonical `corps_key`.                                                                                                                   |
| Domain schema                           | `Domain.CorpsSchema` (`domain.ts`)                                                        | The field shape the old API returned — our parser targets the same fields.                                                                                                  |

## 3. Recon findings (live, fetched via Browserbase)

- **`https://www.dci.org/corps/`** (directory, ~473 KB, HTTP 200): lists every
  corps profile link (`/corps/<slug>/`) **grouped by class** — World Class, Open
  Class, All Age, SoundSport all present. **This is the authoritative,
  up-to-date classes source.**
- **`https://www.dci.org/corps/<slug>/`** (profile, ~181 KB, HTTP 200): per-corps
  page with about/socials/etc.
- Stack: **WordPress + WP Engine + Yoast SEO**, Cloudflare in front. Server-rendered
  HTML (no admin-ajax corps action found), **trailing-slash** canonical URLs
  (`/corps` → 301 → `/corps/`), **1 JSON-LD block per page** (Yoast; typically
  carries name, logo, `sameAs` socials, address — structured + reliable).
- `fetchAPI.create` does **not** follow redirects — always request the
  trailing-slash URL.

## 4. Approach & principles

1. **Archive-first.** Always persist the raw HTML (+ fetch metadata) before
   parsing, in a `corps_page_scrapes` table mirroring `event_page_scrapes`.
   Parsing is then a pure, re-runnable function over stored HTML — we can
   improve parsers and re-ingest without re-fetching.
2. **Browserbase + cache by default.** Route website fetches through Browserbase
   when `BROWSERBASE_API_KEY` is present (fall back to direct fetch otherwise),
   and keep the existing `api_responses` caching on. Drop the dead `network`
   source from the default composite.
3. **Parse defensively, extract everything.** Prefer JSON-LD where present; fall
   back to targeted DOM/HTML extraction. Capture _every_ field we can map to the
   `corps` schema, and stash anything unmapped in a raw JSON column so nothing is
   lost (explore-friendly).
4. **Idempotent + safe ingest.** Upsert by canonical `corps_key` (via the
   existing alias/normalization layer). **Never blindly overwrite** good existing
   data with nulls — merge (coalesce) and track field-level provenance/changes.
5. **Class-change tracking.** Because classes move, record class per corps per
   scrape so we can detect and surface changes over time, not just overwrite.
6. **Polite + resilient.** Concurrency limits, retry/backoff, per-fetch logging,
   resumable runs (skip fresh cache), and a dry-run mode.

## 5. Data model & components (proposed)

- **`corps_page_scrapes`** (new): `corps_slug, scraped_at, source_url,
page_type('directory'|'profile'), http_status, raw_html, parsed_json,
PRIMARY KEY (corps_slug, scraped_at)`. Latest-wins reads, full history kept.
- **`corps_class_history`** (new, optional): `corps_key, season|scraped_at,
division_name, source` — append-only class log for change detection.
- **Fetcher:** `corpsPageScrape` using `BrowserbaseService.fetchHtml` + the
  existing cache (`api_responses` or the new archive), with staleness + retry.
- **Parsers (pure):** `parseCorpsDirectory(html) → {slug,name,class}[]` and
  `parseCorpsProfile(html) → CorpsProfile` (JSON-LD first, DOM fallback).
- **Ingest:** `ingestCorpsFromScrapes` → upsert into `corps` via alias-aware
  `resolveExistingCorpsKey`; write class history.
- **Service:** implement `getCorps()` on the website API from archived/parsed
  data so the composite `DciApi` has a real corps source again.
- **Layer change:** default composite → Browserbase-backed website fetch +
  cache, `['db','website']` (drop `network`).
- **Script:** `scripts/scrapeCorps.ts` (directory + profiles, flags:
  `--refresh`, `--slug`, `--dry-run`, `--concurrency`).

## 6. Milestones & success criteria

### M0 — Recon & plan ✅ (this doc)

- **Done when:** structure/URLs confirmed via Browserbase, gap identified, plan approved.
- **Success:** this document approved; open questions in §8 resolved.

### M1 — Foundation: archive + Browserbase-cached fetch ✅ DONE (2026-06-02)

- Add `corps_page_scrapes` table + upsert; add `corpsPageScrape(url)` using
  Browserbase + cache + retry; flip default composite to Browserbase+cache and
  drop `network`.
- **Delivered:**
  - `corps_page_scrapes` table (raw_html + parsed_json + scraped_at PK = full
    time-travel history) + `idx_corps_page_scrapes_slug`; `upsertCorpsPageScrape`
    / `getLatestCorpsPageScrape` / `DIRECTORY_SCRAPE_SLUG` in `relational.ts`.
  - `src/corpsScraper.ts`: `scrapeCorpsPage()` — Browserbase fetch + staleness
    cache (TTL) + archive; URL builders (trailing-slash aware).
  - `runtime.ts` default composite now `['db','website']` (network dropped) and
    routes website fetches through Browserbase when `BROWSERBASE_API_KEY` is set.
- **Verified:** directory fetch archived (473 KB), 2nd call within TTL = cache
  hit (0 Browserbase calls), archive row written. `relational.ts` + `corpsScraper.ts`
  typecheck clean (the one `runtime.ts` tsc error is pre-existing SDK type-debt).

### M2 — Directory parser → classes ✅ DONE (2026-06-02)

- `parseCorpsDirectory` extracts `{slug, name, division, logo}` for the full roster.
- **Delivered:**
  - `src/corpsParser.ts`: pure `parseCorpsDirectory(html)` — corps grouped by
    class-section heading; canonicalizes `International` → `International Class`.
  - `src/corpsScraper.ts`: `scrapeCorpsDirectory()` (fetch/cache → parse → persist
    roster into the archive row's `parsed_json`) + `diffDirectoryClasses()`
    (roster vs `corps.division_name` by slug).
- **Verified (live roster):** 54 corps parsed (World 21 / Open 16 / All Age 14 /
  International 3), every corps has a division; `parsed_json` stored. Diff: **43
  agree, 6 real class changes** (SoundSport→Open/All-Age promotions; null→class
  for hurricanes/mercedes), **5 unmatched slugs** (`the-` prefix vs `corps.slug`;
  resolved by name/alias at M4). All disagreements are real changes, not parser
  errors. `corpsParser.ts` + `corpsScraper.ts` typecheck clean.
- **Carry-forward to M4:** match roster→corps by name/alias (not just slug) so
  the 5 unmatched resolve; class changes applied via reviewed write.

### M3 — Profile parser → full extraction ✅ DONE (2026-06-02)

- `parseCorpsProfile` (cheerio, pure) extracts: **about** prose (`.common-dis`),
  website, socials (FB/Twitter-X/IG/YT/LinkedIn), **phone** + **email** (contact
  card `tel:`/`mailto:`), **logo** + **cover image** (the two hero images, stable
  order [0]=cover, [1]=logo — logo verified == directory roster logo),
  hometown→city/state, full street address, meta description; raw contact links
  stashed in `raw` for exploration. `scrapeCorpsProfile()` fetches/caches →
  parses → persists into `parsed_json`.
- Field sources are DOM-scoped to the corps' own blocks (`.social`, `.address`,
  `.location`, `.address-user-download`, `.common-dis`, `.hero-section`) so DCI's
  site-wide header/footer socials/contacts aren't picked up. JSON-LD is generic
  Yoast and not used for corps fields.
- **Staff:** not present on dci.org corps pages (no staff section) → skipped.
- **Verified (3 corps, blue-devils/bluecoats/boston-crusaders):** about
  (391–538 chars), website, phone, 4/4 socials, full address, correct logo +
  distinct cover image all captured. Parser pure over stored HTML; typechecks
  clean. (Earlier "thin pages" read was wrong — corrected here.)

### M4 — Ingest (logic + dry-run) ✅ DONE (2026-06-02)

- `src/corpsIngest.ts`: `ingestCorps({ dryRun })` over archived parsed data —
  resolves each roster corps to a canonical `corps_key` (exact slug, else
  alias/name-aware `matchExistingCorpsKey`), **coalescing** upsert of
  division + about/website/socials/phone/email/address/city/state/display_city/
  logo/cover_image/meta_description (`COALESCE(new, existing)` → scraped non-null
  wins, missing never nulls out), logs `corps_class_history`, returns a change
  diff. Schema: `corps_class_history` table + `corps.cover_image` column.
- **Verified (dry-run):** roster 54 → **54 matched, 0 unresolved** (name/alias
  fixed all 5 slug mismatches), 7 class changes detected. With the 3 sample
  profiles parsed, **29 profile-field updates** surfaced — notably refreshing
  **stale `web.archive.org` socials/website** to live URLs, enriching about/
  address, and filling new cover_image. Coalescing confirmed (only non-null
  differing fields change). Typechecks clean.
- **Guardrails (data safety):** `decideWrite` rejects placeholder garbage
  (`---`, `00000`); `city`/`state`/`display_city` are **fill-only** (never
  replace curated HQ location with the scrape's brand city); `address` overwrites
  only when it's an _enrichment_ (contains the existing value); about/socials/
  website/logo/cover/division write. Held overwrites are returned in `summary.held`
  for review, not written. Full-roster dry-run: **447 apply** (122 fills, 225
  wayback→live refreshes, 100 safe real-value: about/address-enrich/logo/division)
  - **48 held** (garbage + brand-vs-HQ location flips + non-enrichment addresses).
- **Deferred:** the actual write (non-dry-run) pending review; website
  `getCorps()` is optional — the app reads the `corps` table directly
  (`CorpsDirectoryService`), so this ingest _is_ the replacement for the dead API.
- **Edge to review:** roster slug `hurricanes` resolves (slug-first) to the
  inactive stub `corps_key=hurricanes` rather than `Connecticut Hurricanes`; the
  lineup alias path is unaffected (it consults `corps_aliases` first). Decide
  whether ingest should prefer the alias over an exact slug stub.

### M5 — Orchestration & full run ✅ DONE (2026-06-03)

- `scripts/scrapeCorps.ts`: end-to-end driver — directory + all profiles via
  Browserbase+cache → archive (raw + parsed, time-travel) → guardrailed ingest;
  flags `--apply` (default dry-run), `--refresh`, `--slug`; writes a JSON report
  to `results/corps-ingest-*.json` (changes + held for review).
- **Full run applied (2026-06-03):** 54/54 matched, **447 writes** (incl. 7 class
  changes), **48 held**. Verified: socials/website refreshed off wayback (0
  remain), 7 class promotions applied (e.g. Memphis Blues → Open Class), 50 corps
  got cover images, `corps_class_history` = 54 rows, curated locations preserved
  (e.g. bluecoats city stays "N. Canton"). **Idempotent**: immediate re-run
  dry-run = 0 writes.
- **Cadence:** ✅ wired into `seasonUpdateWorkflow` — a corps scrape step runs
  after the event/API ingest (cache-based, so only stale pages re-fetch),
  applying when not a dry-run; skippable via `--skip-corps`.
- **Remaining (optional):** concurrency/backoff tuning if Browserbase budget
  needs it; optional website `getCorps()` (not required — app reads the `corps`
  table directly).

## 7. Risks & mitigations

| Risk                                      | Mitigation                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Cloudflare / bot defenses tighten         | Browserbase (already bypassing); backoff + retry; cache reduces fetch volume.           |
| HTML/markup changes break parsers         | Archive-first → re-parse stored HTML; JSON-LD preferred; parser unit tests on fixtures. |
| Overwriting good data with sparse scrapes | Coalescing merge; never null-out; `--dry-run` diff; field provenance.                   |
| Wrong corps identity (dup/alias rows)     | Reuse alias-aware `resolveExistingCorpsKey` + `corps_aliases`.                          |
| Browserbase cost/rate                     | Cache by default + TTL; `--refresh` to force; concurrency cap.                          |
| Class semantics feed the model            | Keep `division_name` writes reviewable (M2 diff list) before bulk apply.                |

## 8. Open questions (need answers before M3/M4)

1. **Overwrite vs. staging:** upsert `corps` directly (coalescing), or land in a
   staging table for a human diff first? (Recommended: coalescing upsert +
   `--dry-run`; staging only if you want a manual gate.)
2. **History depth:** keep full `corps_page_scrapes` history, or latest-only?
   (Recommended: full history — cheap, enables change tracking + re-parse.)
3. **Cadence:** on-demand only, or scheduled (e.g., into `seasonUpdateWorkflow`)?
4. **Scope of "everything":** also scrape corps photo galleries / audio-video
   (MMDL) links / staff, or just the core profile fields for now?

## 9. Out of scope (for this effort)

- Scraping non-corps pages (events already covered; recaps already covered).
- Reviving the dead network API.
- Model/feature changes from class normalization (display-only handled separately).
