# Data Integrity: Slugs, Lineups, Aliases & Encore Duplicates

A consolidated record of the data-integrity problems found in `dci-relational.db`,
their root causes, the fixes already applied, and the remaining reconciliation plan.
Covers four intertwined issues discovered together:

1. **Encore-duplicate lineup rows** (fixed — data + ingest).
2. **Corps alias canonicalization** (fixed — read/emit layer + ingest determinism).
3. **Event ↔ score slug mismatch** (diagnosed; plan below).
4. **Non-unique event slugs** — bare slugs reused across seasons (diagnosed;
   validated migration plan below). *(Earlier framed as "bare-slug event loss";
   corrected — see ⚠️ CORRECTION. Events are not lost; their slugs are ambiguous.)*

All findings are against the **live `sdk/dci-relational.db`** (the schema source of
truth — `relational.ts` is older than the live DB; see CLAUDE.md). The app reads
the precomputed `rm_*` read-model in production and falls back to the builders
(`sdk/src/readModel/builders/*`) in local dev when `READ_MODEL_DB_URL` is unset.

---

## ⚠️ CORRECTION (supersedes parts of §0, §4.2)

An earlier draft of this doc assumed `events.slug` is the primary key. **It is not.**
`events.event_id` is the PK; **`slug` is non-unique.** Verified on the live DB:
1,418 events, **733 distinct slugs**, 1,337 distinct `(slug, season)`.

Consequences (these override the "155 lost recurring events" claim below, which
was WRONG):
- **611 events have prefixed (unique) slugs; 807 have bare slugs**, and **152 bare
  slugs are reused across seasons** (e.g. `drums-of-fire` = 8 rows, 2013–2022).
  Recurring events are **not** lost — each season is a distinct `event_id`.
- The real, measurable bug: **`event_lineup_entries` / `event_participants` /
  `event_page_scrapes` key by `event_slug` with no season.** A lineup under a
  reused bare slug is **ambiguous across every season of that show**. **212
  lineup slugs currently match >1 event row.** In the app the symptom is
  *missing/wrong lineup + metadata* rather than a hard break, because the event
  card already links via `event.competition_slug ?? event.slug` (prefixed) and
  the single-event reader (`buildEventBasic`) does `WHERE e.slug = ?` with no
  season/LIMIT — so a bare slug merges multiple rows.
- **74 `(slug, season)` pairs have >1 `event_id`** — true duplicate event rows
  (e.g. bare `drums-of-fire`@2022 + prefixed `2022-drums-of-fire`).
- DCI's canonical slug is season-prefixed and **unique**; bare slugs are the
  ambiguity source. **The fix is to migrate every bare event to its prefixed
  slug (unique) and key all child rows to it**, then dedupe `(slug,season)`.

The score-derived lineup recovery is still valid, **but it must key rows by the
unique prefixed slug** (a scoped test keyed by the bare slug attached 2013 corps
to all 8 `drums-of-fire` events — reverted). So slug migration precedes derivation.

The Step-2 report has been re-done `event_id`-aware (`reconcileEvents.ts`); the
original slug-based `reconcileEventSlugs.ts` was removed.

**Migration safety (verified by review):**
- `rm_events` is keyed by **`event_id`** (PK), not slug — the read model
  preserves every event row; renaming slugs does not collapse or lose any.
- Migrating `events.slug` bare→prefixed **aligns with existing routing** (the
  event card already prefers `competition_slug`), so it fixes the current partial
  breakage rather than risking links.
- The auto-migration is **collision-free**: 0 canonicals have >1 keep/rename
  survivor. The only residual same-slug pairs (7) are pre-existing **multi-day
  events** already sharing a slug (e.g. `2023-the-beanpot` day1/day2), held in the
  `review` bucket — the migration does not auto-merge them.
- `model_event_prediction_*` already key by prefixed slug (0 bare) → predictions
  survive the rename.

### Corrected migration strategy (decided: migrate slugs → prefixed)

Measured reality (live DB): 807 bare events = **124 unique-slug** + **683
reused-slug**; **59** have a prefixed twin (dedupe); bare child rows —
`event_lineup_entries` 996 (749 on **reused** slugs), `event_participants` 657,
`event_page_scrapes` 300, `event_venues` 807. Crucially, **bare
`event_lineup_entries` have NO `source_url`/`source_scraped_at`** (0/996) — they
cannot be disambiguated to a season.

Therefore the migration **does not try to preserve ambiguous bare derived rows**.
Plan:
1. **Identity:** give every event its canonical **prefixed** slug (`{season}-{slug}`,
   Browserbase-verified; 11 synthetic slugs flagged for review). Dedupe the 59
   `(slug,season)` collisions to one `event_id` (prefer the existing prefixed row).
   Re-key `event_id`-bearing tables (`event_venues`, `event_schedules`) by
   `event_id`.
2. **Discard ambiguous derived data:** delete bare `event_lineup_entries` /
   `event_participants` on **reused** slugs (rebuildable; unique-slug bare rows
   are kept — they're unambiguous).
3. **Rebuild from authoritative prefixed sources:** scraped lineups
   (`rebuildLatestEventLineups`) + score-derived lineups (`deriveLineupsFromScores`,
   now safe on unique slugs), keyed by the unique prefixed slug.
4. **Re-map** `event_to_competition` with the season-safe matcher; re-emit.

**Validated plan** (`scripts/reconcileEvents.ts`, read-only →
`event-migration-plan.json`): of 1,418 events — **457 keep**, **699 rename**
(bare→prefixed), **233 dedupe** (merge into existing canonical), **29 review**
(20 multi-day events sharing a slug+name on different dates — must NOT auto-merge;
9 synthetic 404 slugs). Dedupe groups were validated to share name+date; only
same-day collisions auto-merge. A 3.4 GB DB backup was taken before any write
(`dci-relational.backup-*.db`, gitignored).

**Apply staging (each dry-run-first, verify between):** (1) renames — safest;
(2) same-day dedupe merges with `event_id`-based child re-keying; (3) delete
ambiguous bare derived lineup/participant rows; (4) rebuild lineups (scrape +
score-derived); (5) re-map competitions + re-emit; (6) manually resolve the 29
review cases.

**Stage 1 — APPLIED & verified** (`scripts/migrateEventSlugsStage1.ts`). Renamed
699 bare events → unique prefixed slug (by `event_id`) + re-keyed `event_venues`;
no slug-keyed child moves, no deletes. Result: 1,418 events preserved; distinct
slugs 733→1,219; bare 807→108. Verified against the backup: **0 new slug
collisions** — the 154 remaining prefixed-slug collisions all pre-existed (the
233 dedupe + 5 multi-day review cases).

**Stage 5 (edge cases) — APPLIED & verified** (`scripts/migrateEventSlugsStage5.ts`).
Uniquified the 29 remaining edge slugs: multi-day events sharing a slug
(`2024-dci-eastern-classic` two nights, `drum-corps-an-american-tradition` ×13
across years/days, etc.) get a date-ordered `-N` suffix; corrupted/sponsor bare
slugs (`the-music-man-s-…`, `…-presented-by-…`, `tba-7`) become unique prefixed.
Then re-matched (season-safe) + re-derived. Added a **`competition_corps`
fallback** to `deriveLineupsFromScores` (events with a roster but no `corps_scores`)
→ +24 events. **FINAL: 0 bare, 0 non-unique slugs, 0 orphans; events with a
lineup 601 → 1,170 / 1,185 (98.7%).** The 15 remaining are genuinely data-less
(TBD placeholders, cinema/broadcast events, COVID-era 2021 showcases, a future
2026 event, one multi-day day-2 split).

**Stages 3 & 4 — APPLIED & verified.** 3a/3b (`migrateEventSlugsStage3.ts`):
re-keyed 82 orphaned scrapes via `source_url`, deleted 983 provenance-less orphan
lineup rows. 3c (`ingestLineupsFromScrapes.ts`): rebuilt 523 lineups from scrapes.
3d (`deriveLineupsFromScores.ts --apply`): derived 607 events / 5,607 rows from
`corps_scores` (ambiguous-skip fell 405→15 once slugs were unique). Stage 4:
cleaned 260 orphan + 1 stale cross-season `event_to_competition` rows, re-mapped
673 renamed events (season-safe), 990 mappings, **0 cross-season**. **Result:
events with a lineup 601 → 1,129 / 1,185** (2013–2018 recovered from ~27 to ~100
each). Remaining 51 = 36 no-roster + 15 ambiguous-review. End-to-end verified via
`buildEventSchedule` for recovered events. `season=NULL` count did not regress
(300→260; all resolve via year/start_date). **Pending: re-emit the read model for
production** (`emitReadModel.ts`); dev reads builders live.

**Stage 2 — APPLIED & verified** (`scripts/migrateEventSlugsStage2.ts`). Deleted
233 duplicate event rows (each merged into its validated survivor), explicitly
removing the dupe's `event_venues`/`event_schedules` (FK cascade is off); venues
preserved onto the survivor where it had none (0 needed). Verified vs backup:
events 1,418→**1,185**, the deleted IDs were **exactly** the 233 planned dupes
(0 extra / 0 missed), prefixed-slug collisions **154→5** (only the multi-day
review events), **0 orphaned** venues/schedules. Remaining: 24 bare + 7 collision
groups = the 29 `review` cases. Slug-only child rows (lineup/participants/scrapes)
still need Stage 3.

## 0. TL;DR

- **Lineups** (`event_lineup_entries`) are derived **only** from scraped lineup
  *pages* (`event_page_scrapes`), keyed by the **season-prefixed** scrape slug.
- The app joins lineups by `events.slug`. Legacy events use **bare** slugs
  (`brass-impact`), so the join silently misses → "no lineup."
- DCI's **canonical slug is season-prefixed** (verified live via Browserbase:
  the prefixed URL is `200`, the bare URL is `404`). Bare slugs are an internal
  legacy artifact only.
- Because `events.slug` is a PRIMARY KEY, a bare slug can hold **one season
  only**, so **155 recurring events lost most of their seasons** — those years
  have full cached score/recap data but **no `events` row at all**.
- The data to fix nearly everything is **already cached locally** (season-prefixed
  `competitions`, `website_recaps`, `corps_scores`, `competition_corps`); ~**515
  of 528** missing-lineup events are recoverable with **no scraping**.
- Three separate bugs in the same area were **already fixed**: encore-duplicate
  lineup rows (§6.1), corps-alias canonicalization (§6.2), and compact-recap
  subtotals being halved on reduced (brass-only) judging sheets (§6.3).

---

## 1. Architecture recap — where lineup & score data come from

```
DCI website (Cloudflare-protected, season-prefixed slugs)
  ├─ /events/{season}-{slug}            → event page  ──scrape──▶ event_page_scrapes
  │                                                                 (lineup_json, about_html, …)
  └─ /scores/recap/{season}-{slug}      → recap page  ──scrape──▶ website_recaps
                                                                    (raw_html, parsed_json, corps_count)
DCI API (decommissioned May 2026) ─────────────────────────────▶ api_responses, competitions, …

Derived (rebuildable) tables:
  event_page_scrapes ──▶ event_lineup_entries, event_participants   (lineup PAGE only)
  recap/API/scores   ──▶ competitions, corps_scores, competition_corps,
                          judge_scores, subcaption_scores, category_scores
```

Key asymmetry: **scores/judges/rosters are ingested from recaps/API and keyed by
the season-prefixed `competition_slug`. Lineups are ingested only from lineup
pages and keyed by the scrape slug. The two are bridged for scores — but not for
lineups — by `event_to_competition`.**

---

## 2. How slug matching works (`event_to_competition`)

Two slug namespaces must be bridged:

| Namespace | Form | Examples |
|---|---|---|
| `events.slug` (directory/routing) | **mixed** — legacy bare, modern prefixed | `brass-impact`, `2026-sounds-by-the-seaport` |
| `competitions.slug`, `website_recaps.recap_slug`, `corps_scores`, `competition_corps` | **always season-prefixed** | `2016-dci-minnesota` |

The bridge table (`relational.ts:1111`):

```sql
CREATE TABLE event_to_competition (
  event_slug       TEXT PRIMARY KEY,
  competition_slug TEXT NOT NULL,
  match_method     TEXT NOT NULL DEFAULT 'heuristic',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ...
)
```

Populated by **`scripts/backfillEventCompetitionMapping.ts`**, heuristic order:

1. **date + exact name**, prefer same season, else other season.
2. fallback **date + partial name** (one name contains the other; or core name
   after stripping `finals?|prelims?|semifinals?`, length > 10).
3. last resort **name-only**, same season (core-name match, length > 10; no
   cross-season fallback here).

**Consumption:** the read-model **builders** join through this mapping rather than
raw slugs:
- `buildEventsForSeason` — `competition_match` CTE `LEFT JOIN event_to_competition m`
  (`builders/events.ts:257`).
- `buildJudgeProfile`, `buildEventSchedule`, `builders/recap.ts` — same
  `COALESCE(m.event_slug, …)` pattern.
- The **emitter** (`scripts/emitReadModel.ts`) calls these builders directly, so
  the mapping flows into the emitted `rm_*` tables. (Builders are the single
  source of truth shared by the live-dev fallback and the emitter — no drift.)

This is why **scores and judges resolve for bare events but lineups do not**:
lineups are the one read path not routed through `event_to_competition`.

### 2.1 Flaws in the matcher
- **Cross-season mis-match** ("previous-season matching"): the other-season
  fallback produced exactly one bad row —
  `2023-dci-eastern-classic-2-night-package → 2024-dci-eastern-classic`. The
  cross-season fallback should be removed/guarded (never map across seasons).
- **Name-only matches** (2 rows): lower confidence; acceptable but flag.
- Current mapping stats: **578 rows** — 576 `date+name`, 2 `name-only`; **269**
  mapped events have **bare** slugs pointing at prefixed competitions.

---

## 3. Browserbase verification (Cloudflare bypass)

DCI.org is behind Cloudflare; direct Node `fetch()` returns a challenge page.
`BrowserbaseService` (`sdk/src/browserbaseService.ts`, needs only
`BROWSERBASE_API_KEY`, present in `.env`) fetches via `bb.fetchAPI.create({ url })`
with a direct-fetch fallback. Live probe results:

| URL | Result |
|---|---|
| `dci.org/events/2022-drums-along-the-rockies` | **200**, canonical `…/2022-drums-along-the-rockies/`, `looksBlocked:false` |
| `dci.org/events/drums-along-the-rockies` (bare) | **HTTP 404** |
| `dci.org/scores/recap/2016-dci-minnesota` | **200**, 556 KB, canonical `/scores/final-scores/2016-dci-minnesota/` |

**Conclusions:**
- DCI's **canonical event slug is season-prefixed**; **bare slugs 404** — they are
  not real DCI URLs.
- Recap/event pages are **fetchable live via Browserbase** when cache is
  insufficient (`/scores/recap/{slug}` and `/scores/final-scores/{slug}` share the
  same slug).

> Repro: a throwaway probe script loaded `.env`, provided `BrowserbaseServiceLive`,
> and called `fetchHtml`, peeking `<title>`, `rel=canonical`, and `og:url`. Note
> `.env` on this machine is CRLF — parse with `tr -d '\r'`.

---

## 4. The lineup gap — measured

Totals (1,418 events):

| Metric | Count |
|---|---|
| events with lineup entries | 601 |
| events with non-empty `lineup_json` scrape | 601 (exact 1:1 — derived table is faithful) |
| events with **no** lineup | **528** |

Why the 528 lack lineups:

| Bucket | Count | Recoverable? |
|---|---|---|
| has a cached `corps_scores` / `competition_corps` roster | **515** | ✅ derive, no scraping |
| has a recap with corps (`corps_count>0`) | 510 | ✅ |
| bare event whose `{season}-{slug}` scrape has a real lineup | 42 | ✅ direct |
| **only** 13 have no cached source at all | 13 | ❌ (need live fetch or accept) |
| already have `event_participants` (model input present) | only 42 | — |

**The earlier assumption that ~486 (mostly 2013–2018) were "irrecoverable" was
wrong** — those have full cached recap/score rosters under prefixed slugs.

### 4.1 Slug-format distribution (`events`)
- 300 events have season-prefixed slugs; **818 are bare**.
- Clean (100% prefixed): 2021, 2023, 2026. Transitional/mixed mess: **2022** (96
  prefixed + 41 bare, with duplicate rows for the same show). Mostly bare: ≤2019.
- **59 bare+prefixed duplicate pairs** exist for the same show/season (e.g. both
  `west-texas-drums` and `2022-west-texas-drums`), causing directory
  double-listing and split lineups.

### 4.2 The structural root: bare slug loses recurring events
`events.slug` is a PRIMARY KEY, so a bare slug like `brass-impact` can represent
**one season only**. DCI runs "Brass Impact" 2013–2025; the bare row exists only
for 2022. **155 recurring events** have entire seasons with **no `events` row**,
despite full cached score data under the prefixed competition slug. So the visible
"missing lineups" is the tip of a larger collapse of the events directory.

---

## 5. What's in the cache (inventory)

| Table | Rows | Holds | Slug form |
|---|---|---|---|
| `event_page_scrapes` | 6,913 | lineup pages — `lineup_json`, `about_html` (no full raw page HTML) | prefixed |
| `website_recaps` | 4,789 | recap `raw_html` + `parsed_json` (classes → corps → judge breakdown) + `corps_count` | prefixed |
| `corps_scores` | — | per-competition per-corps: `corps_name`, `division_name` (class), `rank`, `total_score` | prefixed |
| `competition_corps` | 9,360 | roster `(competition_slug, corps_key)` | prefixed |
| `category_scores`, `judge_scores`, `subcaption_scores`, `caption_scores` | many | per-competition scoring (already ingested) | prefixed |
| `api_responses` | 1,151 | raw API JSON cache | — |

`website_recaps.parsed_json` shape: `{ kind, meta:{date,location,title,chiefJudge},
classes:[{ className, corps:[{ corpsName, generalEffect/visual/music:{ judges:[…],
total:{value,rank} } }] }] }` — i.e. performing corps grouped by class with full
judge/subcaption breakdown and per-corps total/rank. More than enough to build a
performing lineup.

**Implication:** for events missing a lineup *page*, a **performing lineup (corps
+ class, ordered by placement)** is derivable from `corps_scores` /
`competition_corps` with no scraping. It lacks times/ceremonies/exhibition rows
(those live only on lineup pages), which is acceptable for historical events.

---

## 6. Fixes already applied

### 6.1 Encore-duplicate lineup rows (data + ingest) — DONE
**Symptom:** a corps shown twice at the encore slot (e.g. `2023-dci-central-indiana`
order 8 had both `Encore - Carolina Crown` and a bare performing `Carolina Crown`).

**Root cause:** an early scraper parse recorded the encore as the bare corps name
(`isNonPerformance:false`); a later parse correctly produced `Encore - …`. Because
`entry_id` was `${slug}-${normalizeKey(name)}-${index}`, the corrected row got a
**different** id and was inserted **alongside** the stale one (the non-overwrite
ingest path early-returns when rows exist, `relational.ts:3621`).

**Scope:** 98 orphan rows across 95 events (2021–2024); validated against the
latest scrape (which contains only the encore). The legit `2024-dci-world-
championship-prelims` order-29 case (Blue Stars + The Cavaliers, two real corps)
was correctly **not** touched.

**Fixes:**
- Data: `scripts/fixEncoreDuplicateLineups.ts` (dry-run default, `--apply`,
  `--slug`) — deletes lineup rows whose `(order, name)` is absent from the latest
  scrape and repairs the affected `event_participants.performance_order`. Applied:
  98 rows deleted, 84 participant orders repaired.
- Ingest: `entry_id` is now **position-only** (`${slug}-${index}`,
  `relational.ts`), so a re-parsed slot updates in place via `ON CONFLICT`.
- Guard: `lineupOrderCollisions()` + `orderCollisions` in
  `planEventLineupRebuild`; `rebuildEventLineupFromScrape` **fails** if a rebuild
  ever reintroduces a same-order non-performance/performance collision
  (`eventLineupRebuild.ts`).

### 6.2 Corps alias canonicalization (read/emit + ingest determinism) — DONE
**Symptoms:** (a) judge "By Corps" grouping split one org into two; (b) duplicated
judge scores; (c) lineup showed the wrong picture for "Hurricanes."

**Root cause:** `corps_aliases` direction is unreliable — the fleshed-out record
(slug + logo) is sometimes the *alias* (`hurricanes`) while the canonical is bare
(`Connecticut Hurricanes`), and a few orgs have **contradictory rows in both
directions** (Bushwackers). Code that trusted `canonical_name`, or ignored aliases,
landed on the wrong record. Separately, `judge_scores` were physically duplicated
under two `corps_key`s (byte-identical) because the name-resolution lookups used
`LIMIT 1` with **no ORDER BY** (nondeterministic when two records share a
normalized name — "Bushwackers Drum Corps" and "Bushwackers" both reduce to
`bushwackers`). 182 such duplicate pairs.

**Fixes:**
- Read/emit: `buildCorpsCanonicalMap()` in `builders/corpsAliases.ts` — union-find
  over the alias name-graph, collapsing each group to the **most complete record**
  (has slug, then logo; tie-break `corps_key`). Applied in `buildJudgeProfile`
  (canonicalize + dedupe scores) and `buildEventSchedule` (re-point `corps_key` +
  `unit_name`). Flows into `rm_*` on re-emit (no `SCHEMA_VERSION` bump — values
  only).
- Ingest: the four name-resolution lookups now
  `ORDER BY (slug IS NULL), (corps_logo IS NULL), corps_key` before `LIMIT 1`
  (`relational.ts`), so every ingest deterministically resolves to one canonical
  key — preventing future score splits.

> Note: existing duplicate score rows still physically exist under both keys; the
> read layer masks them. A data re-point migration (sparse→canonical key, then
> dedupe) was **scoped but not run** — opt-in.

### 6.3 Compact recap subtotals on reduced judging sheets — DONE
**Symptom:** on the prediction/scores page for `2016-cavalcade-of-brass` (and
other brass-only "Cavalcade" events), the **compact** recap's Visual and Music
subtotal columns were ~half the correct value (Carolina Crown showed Visual
**6.95** / Music **14.85** instead of **13.9** / **29.7**), while the **full**
recap showed the correct numbers. The per-caption VP / CG / Brass columns were
(correctly) empty — those captions don't exist for the event, which is what made
it *look* like "VP isn't displaying."

**Root cause:** two recap builders compute the GE/Visual/Music subtotals from
different sources:
- `buildEventFullRecap` reads the published **`category_scores`** row directly →
  always correct.
- `buildEventRecap` → `foldRecapRows` (`builders/recap.ts`) **recomputed** them
  from per-caption columns with a hardcoded full-sheet formula:
  `Visual = (VP+VA+CG)/2`, `Music = (MB+MA+MP)/2`.

That `/2` is only right for the **standard DCI sheet**. DCI runs heterogeneous
sheets: a reduced 5-caption brass sheet (GE1, GE2, Visual-Analysis,
Music-Analysis, Music-Percussion — no Visual Proficiency, Color Guard, or Brass)
where the captions **sum directly** to the total. Verified on the live DB:

| corps_key `001j000000iwx91aad` (Carolina Crown) | `category_scores` Visual | `(VP+VA+CG)/2` |
|---|---|---|
| 2024-cavalcade-of-brass (full sheet) | 22.8 | 22.8 ✓ |
| 2016-cavalcade-of-brass (reduced sheet) | 13.9 | 6.95 ✗ |

For 2016 the five caption scores sum *exactly* to the published total
(15.3+15.7+13.9+15.1+14.6 = 74.6), confirming no halving applies.

**Fix:** `foldRecapRows` now takes the `category_scores` rows and **prefers the
published per-category subtotal** for GE/Visual/Music, falling back to the
caption-sum formula only when a category row is absent (totals-only / partial
events). `buildEventRecap` queries `category_scores` and passes them through.
Both tables now agree across sheet types. Flows into `rm_event_recap` on re-emit
(values only, no `SCHEMA_VERSION` bump).

> Note: `read-model.db` had no `2016-cavalcade-of-brass` row, so local dev was
> already on the builder-fallback path; a re-emit is needed to correct any
> reduced-sheet events already materialized in `rm_event_recap`.

---

## 7. Remaining plan — event ↔ slug reconciliation

Goal: make `events` mirror DCI's canonical **season-prefixed** namespace, recover
the missing per-season rows + lineups from cache, and prevent recurrence.

**Phase 0 — Fix the matcher.** Remove the cross-season fallback in
`backfillEventCompetitionMapping.ts`; require season agreement; re-run dry-run.

**Phase 1 — Recover the 42 (low risk).** Make lineup resolution season-aware
(`buildEventSchedule` + `lineup_counts` look up both `slug` and
`season||'-'||slug`), or write derived lineups under the matched event slug.

**Phase 2 — Dedupe the 59 bare+prefixed pairs.** Choose the prefixed row as
canonical; re-point references (`event_to_competition`, `event_participants`,
`event_lineup_entries`, scores); drop the bare dupe. Dry-run migration (FK fan-out
on `event_slug`).

**Phase 3 — Reconstruct missing per-season event rows (the 155).** Generate the
canonical event set from cached prefixed `competitions`/`website_recaps`; create
the missing per-season `events` rows (metadata from recap/competition; Browserbase
verifies/fills gaps).

**Phase 4 — Derive lineups from cache.** For any event still lacking a scraped
lineup, build `event_lineup_entries` (+ optionally `event_participants`) from
`corps_scores`/`competition_corps` (corps + `division_name` class, ordered by
`rank`/`total_score`), resolved via `event_to_competition`. Coalescing (never
overwrite a real scraped schedule); provenance-tagged `source='scores'` (no
times/ceremonies). Recovers ~515, Cloudflare-free.

**Phase 5 — Browserbase top-up.** For the ~13 with no cached source, and to fetch
real lineup pages (times/ceremonies) for high-value events: fetch live, run the
existing parsers into `event_page_scrapes` (the durable archive), then re-derive.

**Phase 6 — Normalize legacy slugs** bare→prefixed (or add alias/redirect) so
routing/links use one form; **re-emit** the read-model.

**Upstream prevention:**
- Event ingest must emit **season-prefixed** slugs (match DCI) so the bare-slug
  collapse can't recur.
- Route lineup existence through `event_to_competition` so a slug mismatch can
  never again hide a lineup.

**Suggested first artifact:** a **Browserbase-assisted dry-run reconciliation
report** — per season for the 155 recurring + 528 missing-lineup events: canonical
prefixed slug, whether the `events` row needs create/migrate/dedupe, the cached
lineup source, and the few needing a live fetch. No writes until reviewed.

---

## 7a. Reconciliation — Step 1 & 2 results (done)

**Step 1 (matcher fix) — done.** `backfillEventCompetitionMapping.ts` now requires
**season agreement** in every match tier (removed the cross-season fallback), and
derives the event's season from `start_date` (`seasonOf()`), correct for bare
slugs (previously `slug.split('-')[0]` returned the first word, e.g. "brass").

**Step 2 (read-only reconciliation report) — done, then redone event_id-aware.**
The first cut (`reconcileEventSlugs.ts`, slug-based) reported 611 ok / 748 migrate
/ 59 dedupe — **superseded**, because it assumed slug uniqueness. The authoritative
`event_id`-aware plan (`scripts/reconcileEvents.ts`, no writes →
`event-migration-plan.json`; `--verify` via Browserbase cache) against 1,418 events:

| Action | Count | Meaning |
|---|---|---|
| `keep` | 457 | already canonical prefixed |
| `rename` | 699 | bare → unique `{season}-{slug}` |
| `dedupe` | 233 | merge into existing canonical (same name+date) |
| `review` | 29 | 20 multi-day events sharing a slug + 9 synthetic-404 slugs |

Lineup recovery (separate axis): of 528 events with no lineup, **473 derivable
from `corps_scores`**, 42 just need the slug fix, 13 have no source. Only **106**
are safe to derive *before* the slug migration (the rest sit on ambiguous reused
slugs — see `deriveLineupsFromScores.ts`, which now refuses ambiguous slugs).

**Browserbase verification caught a gotcha:** real events return **301** (exist,
redirect to trailing slash), but some canonical slugs **404** — e.g.
`2019-dci-performers-showcase-venue-1..4` are **internal/synthetic** slugs DCI
never exposed. **Blind bare→prefixed migration would mint dead slugs.** Therefore
Step 3 must **Browserbase-verify each target slug** and route 404s to special
handling (these multi-venue showcase events likely collapse to one real DCI page
or are score-only) rather than migrating them.

## 8. Reference — key files & tables

- Bridge: `event_to_competition`; populate `scripts/backfillEventCompetitionMapping.ts`.
- Slug reconciliation: `scripts/reconcileEvents.ts` (event_id-aware plan →
  `event-migration-plan.json`), `scripts/verifyEventSlugs.ts` (Browserbase
  real/synthetic check → `event-slug-verification-cache.json`),
  `scripts/deriveLineupsFromScores.ts` (score-derived lineups; refuses ambiguous
  slugs). `browserbaseService.ts` for Cloudflare-safe DCI fetches. All JSON
  artifacts + `dci-relational.backup-*.db` are gitignored.
- Lineup ingest/rebuild: `relational.ts` (`upsertEventPageScrape`, position-stable
  `entry_id`); `eventLineupRebuild.ts` (`rebuildLatestEventLineups`,
  `planEventLineupRebuild`, `lineupOrderCollisions`); scripts
  `ingestLineupsFromScrapes.ts`, `rebuildDerivedEventLineup.ts`,
  `fixEncoreDuplicateLineups.ts`.
- Aliases: `builders/corpsAliases.ts` (`RELATED_CORPS_CTES`,
  `buildCorpsCanonicalMap`); resolution in `relational.ts`
  (`resolveCorpsKey`/`resolveExistingCorpsKey` + `lookupCorpsKeyBy*`).
- Builders/emit: `sdk/src/readModel/builders/*`, `scripts/emitReadModel.ts`
  (`SCHEMA_VERSION`), `sdk/src/readModel/readers.ts`.
- Browserbase: `sdk/src/browserbaseService.ts` (`BROWSERBASE_API_KEY`),
  `websiteApi.ts` scraper layer.
- Cache: `event_page_scrapes`, `website_recaps`, `corps_scores`,
  `competition_corps`, `category_scores`, `api_responses`.

**Cautions (CLAUDE.md):** treat the live DB schema (not `relational.ts`) as truth;
dry-run/diff before any DB write; the 2.5 GB DB is effectively un-backed-up; never
re-add table DROPs to `ensureRelationalSchema`. Verify the public site via
Browserbase, not plain requests (Cloudflare).
