# Corps Lineup-Driven Discovery & Enrichment Plan

Status: **Draft / proposed** — awaiting approval before implementation.
Owner: TBD · Last updated: 2026-06-03
Companion to: `CORPS_SCRAPING_PLAN.md` (roster-driven scrape/ingest, M0–M5 done).

## 1. Why (the gap)

The existing pipeline (`CORPS_SCRAPING_PLAN.md`) is **roster-driven**: it scrapes
`https://www.dci.org/corps/` (the class-grouped directory, ~54 corps) and only
enriches corps that appear on that page. But the directory is **not** the full
set of corps that actually compete:

- Smaller / regional / SoundSport-tier corps perform in this season's events but
  are **absent from the `/corps/` directory roster**, so they're never probed,
  never scraped, never enriched.
- Yet many of them **do have a real profile page** on dci.org. Examples the user
  found:
  - **Sky Ryders** — in the 2026 DCI Central Texas lineup
    (`/events/2026/2026-dci-central-texas/prediction`), has
    `https://www.dci.org/corps/sky-ryders/`.
  - **Arsenal Drum & Bugle Corps** — `https://www.dci.org/corps/arsenal-drum-bugle-corps/`.

Consequence: these corps show up in lineups/predictions with **no logo, no
class/division, no about/socials** — even though dci.org has a page we could
parse. The directory roster simply doesn't link them.

Two secondary gaps on those pages:

1. **No DCI-hosted logo.** Sky Ryders' DCI page has no logo image, but the corps'
   *own* website exposes a **favicon** we could adopt as a logo fallback.
2. **Class isn't in a heading** (the corps isn't under a directory class section),
   but the profile page **states the class in its text** (e.g. body copy / meta),
   which we can parse.

Goal: **discover corps from event lineups, probe dci.org for a matching profile
page, and enrich them** — extending the existing archive-first pipeline rather
than replacing it. Add a favicon-as-logo fallback and a class-from-profile-text
parser so these thinner corps still get a logo and a division.

## 2. What already exists (reuse, don't rebuild)

| Component | File | Reuse for |
| --- | --- | --- |
| Archive-first page fetch + cache + history | `src/corpsScraper.ts` → `scrapeCorpsPage` / `scrapeCorpsProfile` | Fetch & archive a discovered slug's profile exactly like roster corps. |
| Profile parser (about/socials/address/logo/cover) | `src/corpsParser.ts` → `parseCorpsProfile` | Parse discovered profiles; extend with class-from-text + favicon. |
| Coalescing, guardrailed ingest | `src/corpsIngest.ts` → `ingestCorps` / `decideWrite` | Same safe-merge write path; reuse `fieldsFor`. |
| Alias/name-aware identity resolution | `relational.ts` → `matchExistingCorpsKey`, `corps_aliases`, `resolveExistingCorpsKey` | Map a lineup unit → canonical `corps_key`; map name → candidate slug. |
| Archive table + history | `corps_page_scrapes` (+ `upsertCorpsPageScrape` / `getLatestCorpsPageScrape`) | Store discovered-profile scrapes (raw + parsed). |
| Browserbase fetch (Cloudflare bypass) | `src/browserbaseService.ts` → `fetchHtml` | Same fetcher; favicon fetch may not even need it (corps' own site). |
| Orchestration driver | `scripts/scrapeCorps.ts` (`--apply/--refresh/--slug`) | Add a discovery pass before the roster pass. |
| Lineup data | `relationalQueries.ts` (`orderBy:'lineup'`, `lineup_unit_name`, `lineup_display_city`) + `competition_corps` | Source of corps that actually compete this season. |

**Principle: this is additive.** The roster pass stays authoritative for the ~54
listed corps; discovery only *adds* corps the roster omits and *fills* fields the
roster can't give (logo via favicon, class via text).

## 3. Recon to confirm before building (M0)

Fetch via Browserbase and record findings (mirror §3 of the companion plan):

1. **Profile-page existence signal.** What does dci.org return for a slug with no
   real page vs. a real one (Sky Ryders / Arsenal = 200 with `.common-dis` /
   `.hero-section`; a bogus slug = 404 or a thin "not found" shell)? Define a
   reliable "this is a real corps profile" predicate so discovery probes don't
   create junk archive rows. Capture `http_status` honestly (today `scrapeCorpsPage`
   hard-codes `httpStatus: 200` — discovery needs the real status).
2. **Class-in-text location.** On Sky Ryders / Arsenal, *where* is the class
   stated — body prose (`.common-dis`), a meta/subtitle, a label? Capture exact
   selectors + the phrasings ("World Class", "Open Class", "All-Age", "SoundSport")
   so `parseCorpsClassFromText` is precise (avoid matching the word "class" in
   unrelated prose).
3. **Favicon availability.** For a corps whose DCI page has no logo: does
   `parseCorpsProfile` return `logo: null`? Resolve the corps' own `website`,
   then discover its favicon (`<link rel="icon|shortcut icon|apple-touch-icon">`,
   else `/favicon.ico`). Note format/size — many favicons are 16–32px `.ico`,
   which is poor as a display logo; decide a minimum acceptable size.
4. **Slug-guessing accuracy.** How well does `slugify(lineup_unit_name)` hit the
   real DCI slug? "Sky Ryders" → `sky-ryders` ✓; "Arsenal" → `arsenal-drum-bugle-corps`
   ✗ (needs the full name / a probe of variants). Record the miss rate to size M2.

**Done when:** the existence predicate, class-text selectors, favicon strategy,
and slug-guessing accuracy are confirmed on Sky Ryders + Arsenal + 3–5 other
non-roster lineup corps.

## 4. Approach & principles

1. **Lineups are the discovery source.** Enumerate corps that compete this season
   from the lineup/`competition_corps` data; subtract those already on the
   directory roster and already-enriched ones → the **candidate set** to probe.
2. **Probe politely, archive honestly.** For each candidate, resolve a likely DCI
   slug (slugify name + alias hints + a small set of variants), fetch the profile
   through Browserbase+cache, and **record the real HTTP status**. Only treat a
   page as a corps profile if it passes the existence predicate; archive both
   hits and misses (misses as a 404 marker) so we don't re-probe a known-missing
   slug every run.
3. **Reuse the parser + ingest unchanged where possible.** A discovered profile
   flows through the *same* `parseCorpsProfile` → `fieldsFor` → guardrailed
   coalescing upsert. We only *add* two fallbacks (class-from-text, favicon-logo).
4. **Class authority = a precedence ladder (resolved, was open Q4).** A corps'
   division can come from several sources that disagree; resolve in this order,
   first non-null wins, and **never null-out** an existing class:
   1. **DCI directory roster division** (the current `/corps/` scrape's class-
      section heading) — authoritative when the corps appears on the directory.
   2. **Profile-text class** (`parseCorpsClassFromText`) — for corps *not* on the
      directory (Sky Ryders, Arsenal). **Special case:** if the profile text/
      description says **"SoundSport"**, classify as SoundSport — these corps are
      intentionally absent from the directory's competitive class sections, so
      the text is the only signal.
   3. **Cached API data** (`api_responses`) — the last division the dead DCI API
      recorded, if still archived.
   4. **Existing `corps.division_name`** in the db — preserve what's there rather
      than overwrite with nothing.

   Log *every* class observation to `corps_class_history` with its `source`
   (`directory` | `profile-text` | `api-cache` | `db`) so the chosen division is
   auditable and disagreements are visible in dry-run.
5. **Favicon is a last-resort logo.** Logo precedence: roster logo → profile hero
   logo → **corps-site favicon** (only if above a min size; never overwrite an
   existing real logo — `decideWrite` already protects this as a fill-only-ish
   case, but make favicon explicitly fill-only). Store provenance so a favicon
   logo can later be upgraded.
6. **Cache every media asset's bytes + metadata (resolved, was implicit).** Any
   logo/cover/favicon we adopt is downloaded once and stored in **`media-cache.db`**
   (bytes) with **rich metadata in `media_assets`** (owner=corps, role, format,
   dimensions, source URL, provenance) — see §5. This makes corps branding survive
   DCI/the corps site removing the original, and records *where* each asset came
   from (esp. favicons, which may be tiny/low-quality).
6. **Idempotent + safe, same as M4/M5.** Coalescing merge, never null-out,
   `--dry-run` default, full archive history, resumable (skip fresh cache / known
   404s).

## 5. Data model & components (proposed)

- **Discovery source query** (new, in `relationalQueries.ts` or a small helper):
  `listCompetingCorps(season)` → `{ corpsKey, name, slug?, displayCity? }[]` from
  lineups/`competition_corps`, so discovery is driven by who actually competes.
- **Candidate resolution** (`src/corpsDiscovery.ts`, new):
  - `guessCorpsSlugs(name, aliases) → string[]` — ordered slug candidates
    (slugify, with/without "drum-bugle-corps" suffix, alias-derived).
  - `discoverCorpsProfiles({ season, fetchHtml, refresh })` — for each candidate
    not already roster-listed/enriched, probe slug variants until one passes the
    existence predicate (or all 404), archiving results. Returns discovered
    `{ corpsKey, slug, status }[]`.
- **Archive honesty** (`corps_page_scrapes`): record true `http_status`; treat a
  recently-archived 404 as a cache hit for that slug (don't re-probe within TTL).
  (Add a `not_found` page_type or reuse `profile` + status — decide in M1.)
- **Parser extensions** (`src/corpsParser.ts`):
  - `parseCorpsClassFromText(html) → division | null` — scoped to the selectors
    found in M0; canonicalized via the existing `canonicalDivision`.
  - Surface `logo: null` cleanly (already does) so the favicon fallback can engage.
- **Favicon resolver** (`src/corpsDiscovery.ts` or `corpsParser.ts`):
  `resolveFavicon(siteHtml, siteUrl) → url | null` — parse `<link rel=icon…>` /
  `apple-touch-icon`, resolve relative URLs, fall back to `/favicon.ico`; reject
  too-small icons. (Fetch of the corps' own site can try direct fetch first,
  Browserbase fallback.)
- **Media cache + metadata** — **implemented** as `MediaService` (`src/mediaService.ts`,
  Effect `Context.GenericTag` + `MediaServiceLive` layer; requires the ambient
  relational `SqlClient`). API: `cache` (download-once → bytes + metadata),
  `serve` (raw cached bytes, cache-only — no arbitrary-host proxy), `get`
  (assets for an owner/role), `search` (by owner/role/format/text). Discovery
  calls `MediaService.cache({ ownerType:'corps', ownerId:corpsKey, role:'logo'|
  'cover'|'favicon', sourceUrl })`, which persists:
  - **Bytes** → `media-cache.db` `media_cache(url PK, content_type, bytes,
    byte_length, fetched_at)` — the *same* store the app's `getOrFetchMedia`
    (`app/lib/media-cache.ts`) reads, so cached corps assets are served by the
    existing `/api/media` route with no app change.
  - **Metadata** → `media_assets` (in `dci-relational.db`, currently empty —
    this is its first real use): `owner_type='corps'`, `owner_id=corps_key`,
    `media_type='image'`, `format` (png/svg/ico…), `width`/`height` (probed from
    the bytes), `source_url` (where we fetched it), `url` (the cached/canonical
    URL the app should request), `attribution` (`dci` | corps domain), and
    `metadata_json` = `{ role: 'logo'|'cover'|'favicon', via: 'directory'|
    'profile'|'corps-site', scrapedAt }`. Keyed/upserted on
    `(owner_type, owner_id, role)` so re-runs refresh, not duplicate.
  - **App proxy integration (done):** `MediaService` writes the *same* `media_cache`
    table the app's `/api/media?u=` route reads, so SDK-cached assets are served by
    the existing endpoint. `getOrFetchMedia` now **serves cache hits regardless of
    host** (gating only fetch-on-miss to DCI hosts), and `proxiedImage(url, {
    assumeCached: true })` routes a corps-site favicon through the proxy to our
    durable copy.
  - **SSRF note:** fetch-on-miss (both app and SDK) allowlists only DCI asset
    hosts. Favicons come from arbitrary corps domains, so the *scraper* (a controlled,
    server-side context — not the public proxy) does the favicon fetch and writes
    the bytes into `media_cache` directly; the public `/api/media` route keeps its
    host allowlist intact. (Decide in M4 whether to also widen the route's
    allowlist to serve corps-site-origin URLs, or only ever serve the cached copy.)
- **Class resolver** (`src/corpsIngest.ts` or `corpsParser.ts`):
  `resolveDivision({ rosterDivision, profileText, apiCache, existing }) →
  { division, source }` — implements the §4.4 precedence ladder (directory →
  profile-text/SoundSport → api-cache → db), returning the chosen value *and* its
  source for `corps_class_history`.
- **Ingest** (`src/corpsIngest.ts`): generalize so it ingests **roster corps ∪
  discovered corps**. `division_name` comes from `resolveDivision`; `corps_logo`
  falls back to favicon (fill-only); adopted logos/covers/favicons are passed to
  `cacheCorpsMedia` so their bytes + metadata land in the cache. Everything else
  flows through the existing guardrails unchanged.
- **Orchestration** (`scripts/scrapeCorps.ts`): add a discovery pass
  (`--discover`, on by default) before/after the roster pass; report discovered
  corps, favicon logos, text-derived classes, and **cached media** (count + total
  bytes) in the JSON results file.

## 6. Milestones & success criteria

### M0 — Recon (existence predicate, class-text, favicon, slug accuracy)
- **Done when:** §3 confirmed on Sky Ryders + Arsenal + 3–5 more non-roster
  lineup corps; selectors/predicate/strategy written down here.

### M1 — Archive honesty + existence predicate
- Record real `http_status` in `scrapeCorpsPage`; add `isCorpsProfile(html)`
  predicate; treat archived 404s as cache hits within TTL (don't re-probe).
- **Done when:** probing a bogus slug archives a 404 (no junk parsed row) and is
  skipped on re-run; a real slug archives a 200 profile.

### M2 — Lineup discovery + slug resolution
- `listCompetingCorps` + `guessCorpsSlugs` + `discoverCorpsProfiles`. Subtract
  roster-listed/already-enriched corps to get the candidate set.
- **Done when:** a dry-run over the current season lists candidate corps, resolves
  slugs (incl. Sky Ryders ✓, Arsenal via suffix variant ✓), and reports
  found-vs-404 with no false "found".

### M3 — Class-from-text + favicon + class-authority ladder
- `parseCorpsClassFromText`, `resolveFavicon` (min-size guard), and
  `resolveDivision` (the §4.4 ladder, incl. the SoundSport-from-text case), unit-
  tested against the M0 fixtures.
- **Done when:** Sky Ryders gets a division from text + a favicon logo URL;
  Arsenal gets its division; a SoundSport corps resolves to SoundSport from its
  description; no false class matches on roster corps' prose.

### M4 — Media cache + ingest discovered corps (dry-run → apply)
- `cacheCorpsMedia`: download adopted logos/covers/favicons → bytes in
  `media-cache.db`, metadata in `media_assets` (owner=corps, role, format,
  width/height, source_url, provenance). Generalize `ingestCorps` to include
  discovered corps; favicon logo is fill-only; class via `resolveDivision`,
  observation logged to `corps_class_history` with its real `source`.
- **Done when:** dry-run shows the new corps getting division + favicon logo +
  about/socials; on apply, each adopted asset has a `media_cache` row (bytes) +
  a `media_assets` metadata row; **0 regressions** on the existing roster ingest;
  idempotent re-run = 0 writes and 0 re-downloads (cache hit).

### M5 — Orchestration + full run + cadence
- Wire the discovery pass into `scripts/scrapeCorps.ts` and `seasonUpdateWorkflow`
  (after the roster pass, cache-based). Full applied run + report.
- **Done when:** lineup corps that have DCI pages are enriched end-to-end; report
  lists discovered/favicon/text-class counts; re-run idempotent.

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Slug guessing → wrong page (false match) | Strict `isCorpsProfile` predicate + name cross-check (parsed name ≈ lineup name) before ingest. |
| Re-probing known-missing slugs every run | Archive 404s; treat as cache hit within TTL; `--refresh` to retry. |
| Tiny favicon as logo looks bad | Min-size guard; favicon is fill-only + provenance so it can be upgraded; never overwrite a real logo. |
| Class-from-text false positives | Scope to M0 selectors; only as a *fallback* when no roster division; reviewable in dry-run + `corps_class_history.source`. |
| Probe volume / Browserbase cost | Candidate set = lineup corps minus already-known; cache + TTL; concurrency cap. |
| Identity dupes (discovered vs existing stub) | Reuse alias-aware `matchExistingCorpsKey`; prefer alias over bare slug stub (the M4 edge noted in the companion plan). |
| Caching arbitrary-host favicon bytes (SSRF) | Only the controlled scraper fetches corps-site favicons; the public `/api/media` route keeps its DCI host allowlist; serve the cached copy, not a live arbitrary-host proxy. |
| Media cache growth (bytes in db) | Cache only adopted assets (logo/cover/favicon per corps, upserted by role) — bounded by corps count, not every scraped URL; `byte_length` tracked. |

## 8. Decisions & open questions
**Resolved:**
- **Class authority** → the §4.4 precedence ladder: DCI directory (current) →
  profile-text (incl. SoundSport-from-description) → cached API data → existing db
  value; never null-out; every observation logged with its source.
- **Media** → cache bytes in `media-cache.db` + metadata in `media_assets`
  (per §5); favicon download done by the scraper, served via the existing cache.

**Still open:**
1. **Season scope:** discover from the current season's lineups only, or all
   seasons' competing corps? (Recommended: current season first; widen later.)
2. **Favicon min size / format:** what's the smallest acceptable favicon to adopt
   as a logo (e.g. reject < 32×32)? And do we serve the cached copy only, or also
   widen the `/api/media` allowlist to corps-site origins?
3. **404 storage:** new `not_found` page_type vs. `profile` + real status column?

## 9. Out of scope
- Re-deriving the roster pass (already done in the companion plan).
- Logos/branding beyond favicon fallback (e.g. generating logos).
- Non-DCI corps data sources.
