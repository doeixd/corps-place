# Data-quality & read-model gotchas

Hard-won lessons from debugging the corps/event/merch surfaces. These are the
traps that *look* like UI bugs but are really data-modeling or read-model issues.
Read this before touching event↔score matching, corps appearance cards, the
read-model emit, or anything served through the media-cache proxy.

---

## 1. Two slug namespaces: `events` vs `competitions` (and `event_to_competition`)

There are **two independent data sources** with their **own slugs** for the same
real-world show:

- **`events`** — scraped from the DCI website. Has `event_id` (Salesforce-style,
  e.g. `a0rJw00000ahBL5IAM`) and a `slug` (e.g. `2025-dci-eastern-classic`).
- **`competitions`** / `corps_scores.competition_slug` — from the DCI API. Has its
  own `slug`, which **may differ** from the event slug (punctuation: `u-s` vs `us`;
  suffixes: `-finals`; or just a different spelling).

`event_to_competition (event_slug PK, competition_slug, match_method)` bridges
them, built by `sdk/scripts/backfillEventCompetitionMapping.ts` (run with
`--apply`). It only processes events that **don't already have a mapping**
(`WHERE m.event_slug IS NULL`) — so re-running never *repairs* a wrong row, it only
fills gaps. To fix existing rows you must UPDATE/DELETE them yourself.

**Matcher tier order (after the fix):**
1. **exact-slug identity** — a competition whose slug == the event slug *is* the
   match. This MUST come first.
2. date + name (same season only — never cross-season).
3. date + partial/core name.
4. name-only (same season).

### The bug this caused (2026-06): multi-night sibling events cross-linking

Many shows run **multiple nights** and exist as **sibling event records**:
`2025-dci-eastern-classic` (Aug 2) **and** `2025-dci-eastern-classic-2` (Aug 1);
likewise `…-an-american-tradition-2/-3/-4`. They share a name (and nearly a date).

Before the exact-slug tier existed, the date+name matcher returned the *first
same-name sibling*, so each night cross-linked to the **other** night's
competition slug — and the table even had **bidirectional** wrong rows
(`A→B` and `B→A`). Result: scores were attributed to the wrong night everywhere
that joins through `event_to_competition` (corps appearance cards, recaps, judges).

**Fixes applied:**
- Added the exact-slug identity tier to the matcher (prevents new cross-links).
- One-time corrected the existing rows to identity, **scoped safely**: only flip a
  row to `competition_slug = event_slug` when the event's **own** slug actually has
  scores (`event_slug IN (SELECT DISTINCT competition_slug FROM corps_scores)`),
  so an event is never pointed at an empty competition:
  ```sql
  UPDATE event_to_competition
  SET competition_slug = event_slug, match_method = 'exact-slug'
  WHERE competition_slug <> event_slug
    AND event_slug IN (SELECT DISTINCT competition_slug FROM corps_scores);
  ```

**How to spot it again:** sibling records are real, not junk — don't delete them.
Check footprint per side before touching anything:
```sql
-- cross-links where BOTH sides have their own scores = true sibling dups
SELECT m.event_slug, m.competition_slug,
  (SELECT COUNT(*) FROM corps_scores WHERE competition_slug=m.event_slug)       own,
  (SELECT COUNT(*) FROM corps_scores WHERE competition_slug=m.competition_slug) mapped
FROM event_to_competition m WHERE m.competition_slug <> m.event_slug;
```
Punctuation variants (`u-s`↔`us`) usually duplicate the *same* scores under both
slugs (own == mapped, equal counts); numbered nights have *distinct* scores.

---

### Past-season event gaps — backfill from `competitions`, NOT a website re-scrape

Events come from the DCI **website schedule** (`ingestEventsFromWebsite.ts`), whose
slug is scraped from the live `/events/<slug>/` URL. That URL is only correct for
the **current** season — for recurring shows DCI repoints it to the latest edition,
so **re-scraping a finished season returns next-year slugs** (running
`--season=2025` produced `2026-march-on` for a 2025-dated show; the date is right,
the slug-year is wrong). Don't re-scrape past seasons to fill gaps.

Symptom seen (2026-06): ~39 of 71 **2025** competitions with scores had **no event
row**, so the emit's recap loop (which iterates the `events` table) never built
their recaps → those `/events/2025/<slug>/prediction` pages showed no scores even
though `corps_scores` had them.

Fix: the authoritative source for a past season's events is the **`competitions`**
table (DCI API — stable `<season>-<slug>` slugs + dates; this is how 2022–2024
synthetic events already exist with `event_id = slug`). `scripts/backfillEventsFromCompetitions.ts`
creates an event per scored competition that has no event row, plus an identity
`event_to_competition` row, then you re-emit. Idempotent (gap-fill only). Detect:
```sql
-- A competition is covered if an event shares its slug OR a website event maps to
-- it. Check BOTH or you'll create duplicate events (the website event
-- "…-southwestern-championship" already maps to the API's "…-championship-2").
SELECT DISTINCT cs.competition_slug FROM corps_scores cs
WHERE cs.competition_slug LIKE '<season>-%'
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.slug = cs.competition_slug)
  AND NOT EXISTS (SELECT 1 FROM event_to_competition m WHERE m.competition_slug = cs.competition_slug);
```

**Punctuation/spelling-variant competitions are NOT gaps.** Many shows have two
`competitions` rows for the same real event under different slug spellings
("U.S." → `u-s` vs `us`, "Man's" → `man-s` vs `mans`, `dci-dca` vs `dcidca`),
each carrying a duplicate copy of the scores. Only one spelling has an event (+
identity mapping); the other is an orphaned duplicate whose scores are already
shown via the canonical event — harmless, leave it. The backfill guards against
re-creating these: it skips a competition when an event exists on the **same day**
whose slug matches **ignoring hyphens** (`replace(lower(slug),'-','')`). Genuine
two-night siblings survive that guard (different day, and the `-2` suffix makes the
normalized slugs differ). As of 2026-06 an `--all` run finds **0** true gaps.

**Recovery / enrichment sources — what we actually have:**
- **`competitions` (DCI API):** the authoritative source for a past season —
  stable `<season>-<slug>` slug, `event_name`, `date`, and **`location`** ("City,
  ST"). Use it for both the backfill and to fill `location_city`/`location_state`
  (correct per-season). Other columns: `competition_level` (numeric, not a label),
  `chief_judge` (often a generic default — treat as noise).
- **`event_page_scrapes` (~6,900 rows):** rich website metadata (about, tickets,
  lineup, hero image, address) **keyed by the website slug**. ⚠️ Do NOT enrich a
  backfilled past-season event from a **prior-year** scrape of the same show —
  venues/dates move year to year (March On: Farmington→Rochester→Apple
  Valley→Champlin). Only use a scrape whose slug *and season* match the event.
- **`event_wayback_availability`:** wayback snapshot status per (event_slug,
  season). Sparse for past seasons (≈nothing for 2025) — not a reliable recovery
  path after the fact. `scripts/scrapeWaybackEvents.ts` populates it.
- **Net:** for a finished season's gaps you can recover name/date/location from the
  API, but the website-only extras (tickets, hero photo, about, parking) are
  **gone** unless they were scraped *while the season was live*. Prevention >
  recovery: scrape event pages during the active season before DCI repoints the
  `/events/<slug>/` URLs to next year.

## 2. Keying: appearance results vs appearance cards (event_id ≠ event_slug)

The corps profile's appearance cards key by
`eventCardKey = event_id ?? slug` (`app/lib/event-filtering.ts`). So the per-event
result map **must be keyed by `event_id`** to line up.

But `buildCorpsAppearanceResults` (`sdk/src/readModel/builders/corps.ts`) returns
results keyed by **event_slug** (via `event_to_competition`). The slug→event_id
conversion happens **at emit time** in `emitReadModel.ts` (`eventIdBySlug`), which
freezes `rm_corps_appearance_results.event_id`.

Two failure modes seen here:
- **Whole map empty** if you assume the wrong key — symptom: *no* scores on any
  card. (`rm_corps_appearance_results` not emitted, or keyed by slug while cards
  use event_id.)
- **Most missing, a few present** — the giveaway that some events lack an
  `event_id` so `eventCardKey` falls back to slug and *coincidentally* matches.

**Emit reconciliation (belt-and-suspenders, kept even after the source fix):** a
result is attached to the event the corps **actually appears at** — try the mapped
event_slug, then the raw `competition_slug`, and pick whichever lands in the
corps's *appearance set*; de-dupe per event keeping the highest total (finals over
prelims). This makes the cards robust even if `event_to_competition` regresses.
That's why `buildCorpsAppearanceResults` also returns `competition_slug`.

---

## 3. Read-model: build vs read, and "is it even emitted?"

Every read path has **two implementations** that must agree (see
`AGENTS.md` → Read-model): the live builder (dev, big DB) and the frozen `rm_*`
table (prod). A new read won't work in prod unless `emitReadModel.ts` actually
populates its table. **Grep before trusting:** confirm the `rm_*` table is both
*created* and *INSERTed* in `emitReadModel.ts`, not just read in `readers.ts`.

- `--only <section>` writes a **`*.partial.db`** and does **not** publish. Useful
  for inspection, but a partial emit may leave dependencies empty — e.g. `--only
  corps` has no `allEvents`, so `eventIdBySlug` is empty and appearance rows don't
  build. Use `--only events,corps` together, or a full emit.
- Verify a publish by querying the freshly-written **box** slot
  `sdk/read-model.a.db` (or `.b`), **not** `/data/corps-place/read-model.*.db`
  (those A/B files are the prod *fallback*; prod normally serves the **Turso
  embedded replica**).
- Publish path: `bash scripts/publish-read-model.sh prod --restart` (full emit +
  `--push-turso` + bounce so the new replication generation is picked up).
- **Publish, then deploy/restart — never push to Turso *during* a deploy.**

---

## 4. Merch data-quality patterns (same family of bugs)

- **Duplicate products from shared storefronts:** sibling/feeder/alumni corps
  point at one shop (Bluecoats family, Blue Devils A/B/C). `ingestMerch` elects one
  **primary** store per storefront URL (host-vs-name heuristic) and demotes the
  rest to link-only. See `electPrimaries`.
- **Stale rows:** ingest upserts by `product_id = hash(storeId, externalId)` and
  must **prune** rows from older syncs (`synced_at <> thisRun`) after a non-empty
  fetch, or changed `external_id`s accumulate as same-URL duplicates.
- **Catalog dedup:** `buildMerchCatalogIndex` also dedupes by `product_url`
  (defense-in-depth).
- **Multi-tenant SPA storefronts (Bonfire):** products live at `host/<slug>`, not
  under the store path, so the universal adapter would scrape the platform's
  **global** sitemap and ingest unrelated tenants' products. Such hosts are
  **link-only** (`isLinkOnlyHost`, denylist in `merchCatalog.ts`): keep the Shop
  link, ingest nothing.
- **Bad store detection:** the merch_url scan occasionally latches onto a linked
  third party (GEMS → vicfirth.com via a Facebook link; a corps → a Google Play
  app). Symptom: a store with a suspicious URL (vendor domain, `fbclid=`,
  `/collections/`) and an implausible product count. Fix: `listed=0` +
  null the bad `corps.merch_url`.
- **Client-side filtering must see the FULL set:** the shop catalog paginated
  server-side then filtered only loaded items, so a store/category whose products
  fell past page 1 showed "no matches". Load the full lightweight index and
  filter/sort/paginate client-side (`getMerchCatalog`).

---

## 5. Media cache & image proxy

- **Prod media cache is a bind mount:** `/data/corps-place/media-cache.db`
  (container `MEDIA_CACHE_DB_URL=file:/data/media-cache.db`). It is **root-owned**;
  to write it from a box script, `chgrp corps-place`/`chmod 664` via a throwaway
  `docker run` (sudo needs a TTY). The bind mount means a box-side write is seen by
  the running container immediately (SQLite WAL handles the concurrent reader).
- **`/api/media` serves cache hits regardless of host; fetch-on-miss is
  allowlisted** (`isProxiableImageHost` in `app/lib/media.ts`). So:
  - For allowlisted CDNs (shopify/squarespace/bigcommerce/…+ a few POD hosts),
    rendering through `proxiedImage` and warming via the live proxy is enough.
  - For arbitrary hosts (vendor logos on their own domain), you must **ingest the
    bytes** into the cache yourself (e.g. `scanStoreLogos.ts` via `MediaService`),
    then render with `proxiedImage(url, { assumeCached: true })`.
- **`http://` image URLs** (Squarespace stores them) were rejected by the
  fetch-on-miss `protocol !== 'https:'` guard → the proxy now upgrades http→https
  for allowlisted hosts. Watch for this with any new source.
- **Warming = "ingesting":** `warmMerchImages.ts` GETs every image through the live
  prod proxy (server-side fetch, no browser referrer — defeats hotlink protection)
  so the bytes land in the bind-mounted cache. Warm the **exact** widths the UI
  requests (cards 400/800, detail 720, gallery thumb 96) so variant keys pre-exist.
- **Don't use low-res favicons as logos** — scrape the real brand mark
  (JSON-LD `Organization.logo` → `og:image` → header `<img>` → apple-touch-icon),
  never `/favicon.ico`.

---

## 6. SSR / rendering trap: `<Show>` evaluates children eagerly

`<Show when={x}>{child}</Show>` (jotai-solid-api) is **not** lazy — `child` JSX is
constructed during render regardless of `when`. So `<Show when={!!obj}>{obj!.x}</Show>`
throws when `obj` is null (this 500'd `/corps/gold`, which has no merch store). Use
a React short-circuit for nullable derefs: `{obj && obj.ok ? <…obj.x…/> : null}`.
SSR errors like this show up in `docker logs <prod-container>` (the served HTML is a
generic 500), not in the page body.

---

## 7. The DCI data pipeline at a glance (where each table comes from)

Two upstream sources, ingested by different scripts, joined by `event_to_competition`:

| Table | Source | Ingest script | Notes |
|---|---|---|---|
| `events` | DCI **website** schedule AJAX API | `ingestEventsFromWebsite.ts` | slug = the live `/events/<slug>/` URL → only correct for the **current** season (§1). `event_id` is `web-<season>-<slug>` for website rows, a Salesforce id for older rows. |
| `competitions` | DCI **API** | season ingest | stable `<season>-<slug>` slug, `event_name`, `date`, `location`, `competition_level`, `chief_judge`. Authoritative for finished seasons. |
| `corps_scores`, `caption_scores`, `judge_scores` | DCI **API** | season ingest | keyed by `competition_slug` (the API slug), NOT event_id. |
| `event_lineup_entries` | website scrapes + `deriveLineupsFromScores.ts` | — | who performed; powers lineup chips. |
| `event_page_scrapes` | website event-page HTML | `ingestEventsFromWebsite` / wayback | rich metadata keyed by website slug (§1 recovery box). |
| `event_to_competition` | fuzzy matcher | `backfillEventCompetitionMapping.ts --apply` | bridges website slug ↔ API slug (§1). Only processes UNmapped events. |
| `media_cache` (separate `media-cache.db`) | `MediaService` / `/api/media` | various | image bytes (§5). |

**Related-corps aliasing:** a corps's history is unioned across every `corps_key`
aliased to the same org (`corpsAliases.ts` / `RELATED_CORPS_CTES`) — so a corps that
was renamed/merged still shows one continuous record. Keep this in mind when a
score "belongs" to a corps under an old key.

**Seasons self-heal now:** `seasonUpdateWorkflow.ts` runs
`backfillEventCompetitionMapping` then `backfillEventsFromCompetitions --season`
in its structural-backfill block, so a finished season's event↔score gaps are
filled automatically (the March On bug won't recur). Mapping runs first.

## 8. Operational runbook — applying a data fix

The box's `sdk/dci-relational.db` is the **source of truth**; prod serves a frozen
**read-model** (Turso embedded replica). Mutating the box DB does **nothing** to
prod until you re-emit + publish. So the safe loop is:

1. **Fix the box DB** (SQL or a script). Nothing is live yet.
2. **Verify locally** with a partial emit when iterating:
   `npx tsx scripts/emitReadModel.ts --only events,corps` → inspect
   `read-model.partial.db` (partial emits do NOT publish; include section
   dependencies, e.g. `events,corps` together — §3).
3. **Publish:** `bash scripts/publish-read-model.sh prod --restart` (full emit +
   `--push-turso` + bounce so the new replication generation is picked up).
   **Never push to Turso during a deploy** (§ read-model in AGENTS.md).
4. **Verify the published box slot** — query `sdk/read-model.a.db` (or `.b`, per
   `read-model.active`), NOT `/data/corps-place/read-model.*.db` (those are the prod
   *fallback*; prod serves the Turso replica).
5. **Verify live** with a Host-header curl: `curl -k -H 'Host: drumcorps.app'
   https://127.0.0.1/<path>` (give the replica ~30–60s to warm after the restart).

**Reverting a script run:** the website ingest tags its rows (`event_id LIKE
'web-<season>-%'`), so an unwanted `ingestEventsFromWebsite --season=X` is
reversible with `DELETE FROM events WHERE event_id LIKE 'web-X-%'`. There's also a
nightly restic→R2 backup of the box DB (`scripts/backup-relational.sh`).

**Diagnosing a "no data on the page" bug:** check in this order —
(a) does the row exist in the box DB? (b) is it reachable via `event_to_competition`
/ keying? (c) is it actually **emitted** into the `rm_*` table? (d) does the live
Turso replica have it (restart needed after publish)? Most "UI bugs" here are (b)
or (c).

## 9. Diagnostic query cookbook

```sql
-- Scored competitions a season has no event/mapping for (true gaps — should be 0):
SELECT DISTINCT competition_slug FROM corps_scores cs
WHERE competition_slug LIKE '<season>-%'
  AND competition_slug NOT IN (SELECT slug FROM events)
  AND competition_slug NOT IN (SELECT competition_slug FROM event_to_competition);

-- event_to_competition cross-links where BOTH sides have their own scores
-- (true two-night siblings vs misattribution — see §1):
SELECT m.event_slug, m.competition_slug,
  (SELECT COUNT(*) FROM corps_scores WHERE competition_slug=m.event_slug)       own,
  (SELECT COUNT(*) FROM corps_scores WHERE competition_slug=m.competition_slug) mapped
FROM event_to_competition m WHERE m.competition_slug <> m.event_slug;

-- Same-name + same-day duplicate event records (genuine multi-night events differ
-- by DAY, so anything here is a same-day dup worth investigating):
SELECT name, substr(start_date,1,10) d, COUNT(*) n, group_concat(slug,' | ')
FROM events WHERE start_date LIKE '<season>-%'
GROUP BY name, d HAVING n>1;

-- Events whose slug-year disagrees with their date-year (website slug bug, §1):
SELECT slug, start_date FROM events
WHERE start_date LIKE '2025-%' AND slug NOT LIKE '2025-%';

-- corps_scores pointing at a non-existent corps_key (orphans — should be 0):
SELECT COUNT(*) FROM corps_scores cs
WHERE NOT EXISTS (SELECT 1 FROM corps c WHERE c.corps_key=cs.corps_key);
```

## 10. Non-scored "package" events are legitimate — don't treat as bugs

Some `events` rows are **ticket bundles / non-competition listings**, not scored
shows: e.g. "2025 Super 3 DCI World Championships" (the 3-day pass, distinct from
the prelims/semis/finals which each have their own scored event), "…-night-package",
"…-tour-premiere", "Drum Corps at the Cinema". They legitimately have **no scores
and no recap** — showing an empty recap is correct. Don't backfill or "fix" them;
they may also carry odd multi-year slugs (e.g. `2024-2025-super-3-…`) by DCI's own
branding. A no-score event is only a bug if a **scored** `competition` for the same
real show exists with no event pointing at it (§1).

---

## 11. `caption_scores` is dirty — it silently poisons the prediction curves

`caption_scores` (one row per corps × subcaption per show) feeds the **V4 reference
curve** (`sdk/scripts/computeReferenceCurvesV4.ts` → `src/training/referenceCurvesV4.json`)
and the **V9 feature builder**. The curve is the per-`(rank, %-through, caption)`
baseline that every in-season prediction anchors to, so a bad row here shows up on
the site as an impossible caption (e.g. a corps with 19 VP and 10.8 VA). These are
NOT UI bugs — they are dirty source rows averaged into the baseline.

### 11a. Caption-name drift → a whole caption silently vanishes (the VA bug, 2026-07)

The DB stores the visual-analysis caption as **`"Visual - Analysis"`** (hyphenated,
like `"Music - Analysis"`). There are **zero** `"Visual Analysis"` (no-hyphen) rows.
Any code that maps the no-hyphen spelling matches nothing and **silently drops VA**
(`if (!slug) continue`). The curve generator's `CAPTION_MAP` had the no-hyphen key,
so a regeneration would produce a curve with **no VA column at all**; the broken
`8.8`-VA column that actually shipped was a **stale artifact** carried in by a bulk
"Restore full project tree" commit (see the V9 memory), never regenerated.

Why only VA was hit: every *other* caption name matched — `"Visual Proficiency"`,
`"Color Guard"`, and the already-hyphenated `"Music - *"`. VA was the one caption
whose DB name has a hyphen the map lacked.

Canonical DB caption names (whitelist):
```
General Effect 1 · General Effect 2 · Visual Proficiency · Visual - Analysis
Color Guard · Music - Brass · Music - Analysis · Music - Percussion
```
Judge names also leak into `caption_name` (e.g. `"M. Turner"`) — 3 rows.

**Fix / prevention:** map BOTH spellings to `VA` (the V9 subcaption builder already
does; the curve generator now does too) and **whitelist** caption names so anything
unknown is skipped. The generator now **aborts** if any mapped caption matches 0
source rows — a rename can no longer silently drop a caption.

### 11b. Out-of-range caption scores — and why the fix is *exclude*, not *repair*

A real subcaption tops out ~20 (older GE scale reaches ~24). Two out-of-range
classes exist in `caption_scores`; we investigated repairing them (2026-07-09) and
concluded **neither is a corrupted value that can be repaired** — one is off-domain,
the other is genuinely absent. Excluding is correct, not lazy. Details:

**(1) High values (80–99) = off-domain I&E scores, NOT corruption, and they never
reach the curve.** ~700 rows have a full total (80–99) in a subcaption cell
(`Music - Brass` up to 99, `Visual Proficiency` 93), concentrated in 2017–2019.
These are **Individual & Ensemble / individual-performer** rows scored on the ~100
scale — e.g. `noah-aguillon-troopers` is *Noah Aguillon*, an individual brass
soloist at a "Performers Showcase"; his `89.0` **is** the correct I&E total. Nothing
to repair — the value is right for what it is, just off-domain. The generator's
existing `WHERE cs.division_name = 'World Class'` filter **already excludes all of
them** — 0 reach the World-Class curve. (The `score <= 25` upper bound below is
belt-and-suspenders against a future mis-tagged division.)

**(2) Zeros = genuinely MISSING data (DNP / standstill / no-recap), NOT repairable.**
The only out-of-range rows that actually reach the curve are **565 all-zero panels**
across **74 World-Class corps-events**: `total_score = 0`, all 8 captions `0`, and
the matching `subcaption_scores` are `0`/absent too. These are corps that didn't
receive a scored caption breakdown (exhibition, standstill, DNP, missing recap).
**0 of 565 are recoverable** from any source (0 have a real total; 0 have matching
non-zero subcaptions), so "repair" would mean **fabricating** scores — which biases
the curve worse than dropping the row. Averaged in un-dropped, they drag cells toward
zero.

**Where repair *would* be valid** — a real World-Class corps in a real show with one
zeroed caption and 7 clean siblings (recompute the one cell from `subcaption_scores`
or `total − Σsiblings`) — the entire history has **~1 such row**. Not worth a code
path.

**Fix / prevention:** the generator filters to `0 < score <= 25` and logs the drop
count. Read this as *"drop panels with no recorded caption data (zeros) and any
stray out-of-domain magnitude"* — an **exclusion of non-data**, not a discard of
signal. If a future audit finds genuinely-repairable rows (clean siblings, real
total), prefer recomputing from `subcaption_scores` over dropping.

### 11c. Rank range: curves only need ranks 1–25

`v9Baselines.ts` clamps the lookup rank to `[1, 25]` (`Math.max(1, Math.min(25, …))`),
so any rank-26+ curve cell — including the sparse `"100-*"` "unranked" sentinels —
is **never read**. Keeping them only bloated the file and tripped sanity checks on
noise. The generator now emits **only ranks 1–25**.

### 11d. Guards so this can't silently recur

- **Generator self-validation** (`computeReferenceCurvesV4.ts`): before writing it
  asserts (a) every mapped caption matched >0 source rows, (b) every curve key
  carries every caption, (c) no caption sits >3 pts **below or above** its sibling
  mean at the same key (below = a dropped/corrupt column like VA; above = total
  leakage). It **refuses to write** a bad curve. `CURVE_DB_PATH` / `CURVE_OUT_PATH`
  are env-overridable for dry-runs.
- **File-level test** (`sdk/test/referenceCurveIntegrity.test.ts`, run
  `vp exec tsx test/referenceCurveIntegrity.test.ts` from `sdk/`): validates the
  **committed** JSON directly (completeness + symmetric sibling anomaly). This is the
  guard that catches a corrupt artifact that **bypassed the generator** — the exact
  path the stale VA column took.

### 11e. How to regenerate the curve cleanly

```bash
cd sdk
# dry-run to a temp file first and eyeball the "Dropped N …" + "Validation OK" lines
CURVE_OUT_PATH=/tmp/curve.json vp exec tsx scripts/computeReferenceCurvesV4.ts
# if clean, write for real, then gate on the integrity test + a backtest
vp exec tsx scripts/computeReferenceCurvesV4.ts
vp exec tsx test/referenceCurveIntegrity.test.ts
vp exec tsx scripts/backtestPredictionModes.ts --cutoffs 2025-07-15,2025-07-30
```
The live curve is the fully-clean regen (adopted 2026-07-09) — judge any curve
change on the **ensemble / target mode**, never `curve` mode alone (a full v4.1
division-aware swap was rejected for regressing the P2 ensemble +0.155; see the V9
memory). After a curve change, regenerate the site-wide predictions (§8).

### 11f. Diagnostic queries

```sql
-- name drift: every caption name + range (spot the totals & judge-name rows)
SELECT caption_name, COUNT(*), ROUND(MIN(score),1), ROUND(MAX(score),1)
FROM caption_scores GROUP BY caption_name ORDER BY 2 DESC;

-- out-of-range contamination among known captions
SELECT caption_name, COUNT(*) FROM caption_scores
WHERE caption_name IN ('General Effect 1','General Effect 2','Visual Proficiency',
  'Visual - Analysis','Color Guard','Music - Brass','Music - Analysis','Music - Percussion')
  AND (score > 20.5 OR score <= 0)
GROUP BY caption_name ORDER BY 2 DESC;

-- a curve cell where one caption diverges from its siblings (corruption smell)
-- inspect referenceCurvesV4.json directly; the integrity test automates this.
```

The emit's `dq_*` guardrails (`dq_invalid_caption_scores`, `dq_zero_scores`,
`dq_rank_inversions`, `dq_missing_caption_panels`, …) quantify the raw contamination
and are the right thing to gate on if this is ever tightened further. **Open item:**
the V9 feature builder reads the same dirty `caption_scores`; a clean rebuild +
retrain is the natural next step (not yet done as of 2026-07-09).
