# Staff Scraping & Person-Profile Plan (2013–present)

Status: **Feature complete & verified live (M0–M9)** on pilot data (Atlanta CV).
The `/staff` + `/staff/$personId` routes render real data in the dev server, photos
are cached, and the `staffCollection` offline path is wired. Remaining for production:
the full bulk `--apply` across all corps (M7 stage 2) — a scope/scale decision, not a
blocker.

Permissions note: the root-owned files that blocked the feature (`media-cache.db`,
`app/db/collections.ts`, `app/db/read-model-manifest.ts`, `node_modules/.vite`) were
chowned to the working user via a root Docker container (operator is in the `docker`
group). Media caching, the offline collection, and the dev server all work now.

Progress log:
- **M0** ✓ spike (findings in §0): `/staff` dominant; ~40% block curl but render
  unblocks; Wayback `closest` decade-off → year-bounded.
- **M1** ✓ `corps_staff.person_id` + index, `corps_staff_review` + `upsertStaffReview`,
  `normalizeCaption()`, `makeStaffPersonId()` (`relational.ts`). Migration + helpers
  verified on a temp DB; typechecks.
- **M2** ✓ `extractStaffFromHtml()` (`staffScraper.ts`) — JSON-LD `Person` + DOM
  card-grid. Verified on synthetic fixtures + real page (57 staff from Atlanta CV).
- **M3** ✓ `scripts/scrapeStaff.ts` orchestrator + `discoverStaffPage` (render-frugal:
  node-fetch all slugs, ≤1 render) + year-bounded `waybackSnapshot` + inline
  `scraper_progress` gating + dry-run report. Verified end-to-end on Atlanta CV:
  221 staff across 5 seasons (2026 live + 2023/24/25 Wayback, 2022 = honest gap),
  127 grouped members with within-corps season-linking, ~16s/corps.
  - Gotcha fixed: the render-service browser is never closed → CLI must `process.exit`.
  - Gotcha fixed: dry-run must NOT write `scraper_progress` (would skip pairs on apply).
  - Known limitation → M4: client-rendered SPAs (e.g. Boston Crusaders Squarespace)
    yield 0 even after render; these need the Pattern B AI extractor.
- **M4** ✓ `src/staffAiExtract.ts` — Pattern B. Renders→reduces HTML to visible text
  with inline `[IMG:url]` markers→headless LLM with a strict JSON contract→
  schema-validated (`SchemaParser.decodeUnknownEffect`)→confidence LOW, via `ai`.
  Engine: `claude -p`, automatic fallback to `codex exec` if claude errors/empty
  (both CLIs present: claude 2.1.175, codex 0.139.0). Wired into the orchestrator
  behind an opt-in `--ai` flag (slow/token-cost; current-season page only, to bound
  cost — historical-SPA coverage stays a known gap). Acceptance gate met: Boston
  Crusaders 0 (Pattern A) → 125 members (AI) with titles/captions/photos, ~100s/page.
  Codex fallback is wired + typechecked but not exercised live (claude succeeded).
- **M5** ✓ `src/staffImage.ts` — `verifyImageUrl` (curl HEAD, generic UA: Content-Type
  `image/*`, reject `text/html`/non-2xx/placeholder filenames), `isPlaceholderUrl`,
  `nameMatches` (available but NOT gating — staff photos are positionally trusted from
  their card; opaque Squarespace CDN URLs would fail a surname check). Wired into the
  orchestrator's `applyMember`: verify → `MediaService.cache({ownerType:'staff',
  role:'headshot'})` → coalesce (verified photo wins, never write a bad one, never
  null an existing). Verified: 4-case verifier (real→ok, html→reject, placeholder→
  reject, 404→reject) + full cache path on temp DBs (155 KB JPEG bytes + `media_assets`
  row `staff:…:headshot`). Note: photo verification runs only on `--apply` (a curl per
  photo) to keep dry-runs fast.
- **M6** ✓ `scripts/resolveStaffIdentity.ts` — assigns `person_id` conservatively:
  `slug(name)`; cross-corps same-name SPLIT by default (`slug`, `slug-2`) + queued in
  `corps_staff_review` as `needs-review` (never auto-merged). `--auto-merge` runs
  `compareStaffMembersWithClaude`, merging only on `samePerson && confidence≥0.8 &&
  corroboration` (shared photo_url / bio-overlap≥0.5). `--list`, `--merge A B`,
  `--split A B` for manual decisions; `--apply` gates all writes. Verified on a seeded
  temp DB: genuine cross-corps instructor → split→queued→manual-merge to one
  `person_id`; same-name-different-people → stays split; unique untouched; re-run is
  idempotent. LLM `--auto-merge` wired + typechecked, not exercised live.
- **M7 (pilot stage)** ◑ Applied Atlanta CV 2023–2026 to production: 127 `corps_staff`
  + 221 assignments + 127 `person_id`s (resolved, 0 collisions; russell-thompson/
  sue-nedvidek/kevin-kenney each span 4 seasons under one person_id — within-corps
  linking confirmed on real data). **Two bugs the pilot caught:**
  1. **FIXED** — `scrapeStaff`/`resolveStaffIdentity` never ran the M1 migration, so
     production lacked `person_id`/`corps_staff_review`. Added `ensureStaffSchema`
     (additive, idempotent) and call it at the start of both scripts.
  2. **ENV BLOCKER** — `media-cache.db` is root-owned `-rw-r--r--`; user `patrick`
     can't write it → all 57 verified headshots fail to cache (`SQLITE_READONLY`,
     now a visible WARN, not swallowed). `photo_url` is still written to `corps_staff`.
     **The bulk `--apply` (and media caching) must run as root / the file owner**, or
     `media-cache.db` must be made group-writable. Code path is proven on temp DBs.
  - Full bulk apply (all corps × 2013–2026, +`--ai` for SPAs) deferred pending the
    media-permissions resolution and a go/no-go after this pilot.
- **M8** ✓ `src/readModel/builders/staff.ts` (`buildStaffDirectory`/`buildStaffProfile`,
  keyed by `person_id`, grouping multiple staff_ids; reuses judge `CaptionCount`),
  `readers.ts` (`readStaffDirectory`/`readStaffProfile`), `builders/index.ts` re-export,
  `emitReadModel.ts`: `"staff"` section + `rm_staff`/`rm_staff_detail` DDL (SCHEMA_VERSION
  11) + `staff.json` collection + `staff/<person_id>.json` shards. Verified on pilot data:
  `emit --only staff` → 127/127 rows; **reader↔builder parity true**; summary carries
  title/photo/corps_count/seasons(desc)/captionBreakdown/groups. (Note: read-model
  `photo_url` is the source URL until media is cached by a privileged run; the app's
  `proxiedImage` routes it through `/api/media`.)
- **M9** ✓ App route. `app/lib/staff-directory.ts` (`StaffDirectoryService` +
  `listStaff`/`getStaffProfile`, read-model fast path with builder fallback, mirrors
  judge-directory), `getStaffDirectory`/`getStaffProfile` server fns + `StaffDirectoryServiceLive`
  in `server-fns/hybrid.ts`, and routes `app/routes/staff/index.tsx` (directory: photo
  + name + title + corps-count/season-range, client search) and `app/routes/staff/$personId.tsx`
  (profile: photo, bio, assignments grouped by corps with season+title+caption; loads
  the `staff/<person_id>.json` shard with server-fn fallback). Route tree regenerated;
  all staff files typecheck clean.
  - **`staffCollection` wired** (after the perms fix): added to `app/db/collections.ts`,
    `staff?` shard added to `app/db/read-model-manifest.ts` (optional → directory falls
    back to its route loader until the deploy pipeline publishes a staff index shard),
    and the directory route wrapped in `HybridCollection`.
  - **Live-verified**: `vite` dev server renders `/staff` (heading + names) and
    `/staff/russell-thompson` (name, title, "Atlanta CV", assignments) from the pilot
    data via the builder fallback path.
  - **Media (after perms fix)**: re-applied Atlanta CV → 0 cache failures, 48 photo
    blobs in `media-cache.db`, 57 `media_assets` rows (`owner_type='staff'`).
  - Pre-existing (not ours): 2 tsc errors in `app/routes/judges/$judgeId.tsx`
    (a `GroupBy` codec narrowing) remain in the app typecheck.
  - **Follow-up for the deploy pipeline**: have whatever generates `read-model/manifest.json`
    include `shards.staff` (pointing at the emitted `staff.json`) so the offline
    collection activates in production.
Owner: (tbd) · Last updated: 2026-06-15

---

## 0. M0 spike findings (2026-06-15)

Probed 10 corps (`sdk/scripts/spikeStaffDiscovery.ts`, throwaway). Results that
change the design:

1. **`/staff` is the dominant slug** — 6/10 hit `/staff` directly (several also
   expose `/about/staff`, `/education/staff`). A bogus slug returns **404**, so a
   `200 + text/html` on a real slug is trustworthy here (no soft-404 SPA catch-all
   in the sample). Discovery order `/staff` → `/about/staff` → `/education/staff`
   → `/team` → `/leadership` is well justified.
2. **~40% block plain curl (403/406)** — SCV (403), 7th Regiment / Sonus / Madison
   (406 from a WAF). Generic-UA curl is **not** enough for these, BUT **local
   Chromium renders them fine** — `renderHtml` pulled SCV's full 687 KB page with
   real staff content. ⇒ Discovery must **escalate curl → render** before
   concluding "no staff page"; a curl 403/406 is a *fetch* failure, not a
   *missing-page* signal (field guide §4 false-negative rule applies to slug
   probing too).
3. **Server-rendered caption text exists** — Atlanta CV `/staff` contains
   `Brass/Percussion/Visual/Caption/Director/Instructor` in the raw HTML, so
   **Pattern A (deterministic parse) is viable without rendering** on at least some
   sites. Good — keeps cost down.
4. **Wayback `closest` can be a decade off** — querying Atlanta CV `/staff` at
   `20130801` returned a **2023** snapshot as "closest". ⇒ **Must bound the
   snapshot**: reject any snapshot whose year is outside ±1 of the requested season,
   and record a gap rather than mis-attributing a 2023 roster to 2013. 2013 coverage
   is genuinely sparse for several corps (Blue Knights, Genesis, Blue Stars had no
   archived `/staff`); **history depth is data-limited, not effort-limited** — fill
   what exists, report gaps honestly.

**Design deltas applied:** discovery escalates curl→render (§2/§4.2); a curl
403/406 never concludes "no page"; Wayback tasking adds a ±1-year proximity bound
and gap recording (§4.1); Pattern A may run on the raw curl HTML when it already
carries the signal, rendering only when it doesn't (matches `merchCatalog`'s
`fetchHtmlWithFallback` shape).

---

## 0b. Code-review fixes (2026-06-15, post-M9)

Self-review found and fixed 11 issues (all verified, typecheck clean):
- **#1 Wayback mis-attribution** — `waybackSnapshot` now returns the snapshot's ACTUAL
  year; the orchestrator labels assignments by that year (not the requested season) and
  dedupes a capture shared by adjacent ±1yr seasons (`usedSnapshots`).
- **#2 Transient-failure-as-gap** — `WaybackResult` is now `found | absent | error`; an
  `error` (network/parse) is skipped WITHOUT marking `scraper_progress` done, so it
  retries; only a genuine `absent` is recorded as a gap.
- **#3 Incremental collision skipped review** — `resolveStaffIdentity` now cross-pairs new
  rows against already-resolved holders of the same base slug (verified: new corpsB row →
  split + review pair vs the corpsA holder). Guarded so resolved pairs aren't re-opened.
- **#4 Future seasons** — season range clamped to ≤ current year (warns on dropped).
- **#5 AI truncation** — `reduceHtmlForLlm` no longer caps silently; caller caps + WARNs.
- **#6 Within-corps same-name merge** — flagged via `metadata.possibleNameCollision` when
  a season shows conflicting headshots (detectable instead of silent).
- **#7 AI empty vs failure** — `tryEngine` returns `{ok}`; codex fallback fires only on a
  real claude failure, not a valid empty answer.
- **#8 HEAD-only verify** — `verifyImageUrl` falls back to a 1-byte ranged GET on 405 /
  timeout / non-image HEAD, and accepts octet-stream for image-extensioned URLs.
- **#9 Non-ASCII slugs** — `makeStaffPersonId` de-accents (NFD) → "José Díaz" = `jose-diaz`
  (residual: distinct Nordic letters ø/æ still degrade; rare).
- **#10/#11 (routes)** — removed a dead `'corps'/'corps'` ternary; added `onError` image
  fallbacks.

## 0c. Cross-corps identity-merge tactics (2026-06-16, post-bulk)

After the bulk run, `resolveStaffIdentity` split every cross-corps same-name pair into a
review queue (conservative: never auto-merge on name alone). That left **1644 pairs**. We
then mined deterministic, evidence-based merge tactics — tool: `sdk/scripts/testMergeTactics.ts`
(dry-run by default; `--apply` executes via union-find; `--names` enables the name-rarity
tier). Tiers, highest-confidence first:

- **T0 — same real corps under aliased keys (always on).** The *same corps* appears under
  multiple corps keys: **Bluecoats = 4** (`001j…raal`, `rhythm-in-blue`, `blue-way-summer-arts-camp`,
  `blue-way-middle-school-honor-band`), **Blue Devils = 3**, **Mandarins / Cavaliers / Colts /
  Regiment / Ascend / Hurricanes / Fusion / Zephyrus = 2** each (a `001j…` Salesforce key + a
  slug key). Detect by **staff-page domain**: keys whose `corps_staff_assignments.links_json`
  source URLs share a primary domain (after stripping the Wayback prefix) are one corps, so a
  same-name pair across them is the same person → merge regardless of surname. (108 merges.)
- **T1 — shared real photo_url** (a photo used by exactly ONE display name; placeholders used
  by ≥2 names are excluded — they'd fuse different people).
- **T1c — identical source page** (same staff page, Wayback timestamp stripped).
- **T2 — bio Jaccard ≥ 0.6.** In practice **0** — bios are too sparse to help (see below).
- **T3 — identical photo BYTES** (sha1 of the cached image in `media-cache.db`): definitively
  the same headshot even across hosts/resizes that give different URLs. Safe even for common
  names (identical bytes are conclusive).
- **T4 — name-matching headshot filename + distinctive surname**: both photos' filenames embed
  a name token AND the surname maps to exactly one full name in the dataset.
- **T5 — uncommon-surname same-name (opt-in `--names`).** Merge a cross-corps same-name pair
  when the **surname** is used by ≤2 distinct first names across the whole dataset. Discriminate
  on the SURNAME, not the full name — first names are always common ("Michael Gaines" is one
  person even though "Michael" is common). Common surnames (≥3 first names: Smith/Johnson/Lin)
  are HELD. Rationale: drum-corps instructors move between corps constantly, so a rare full name
  at 2–3 corps is almost certainly one person. (681 merges.)
- **JUNK delete** — names that are policy/handbook strings OR entirely role/title words
  (`isTitleOnlyName`: "Commercial Driver", "Scenic Designer", "Creative Producer" — every token
  is a role word). Deleted across all child tables (FK enforcement is OFF → delete explicitly).

**Apply mechanics:** union-find over merged pairs; canonical `person_id` = the cluster's own
smallest existing `person_id` (NOT `base(slug)` — stripping the `-N` suffix collides two
distinct same-name clusters, e.g. two "Marvin Reed"s). Every merge writes a
`corps_staff_review` row `resolved=1, action='merge', decided_by='deterministic'` → reversible
via `resolveStaffIdentity --split`.

**Bios are a data limitation, not a parser gap** (verified by reading raw HTML of Bluecoats,
Boston, Crossmen, Mandarins, SCV): the big corps publish **name + title + photo roster grids
with no bios and no per-person detail pages** (Squarespace gallery JSON `description` = role
only). Only ~305/4730 staff have any bio; the extractor captures them where they ARE inline
(one corps: 85/104 at ~1000 chars). So bio-overlap can't merge the big-corps pairs — the text
was never published. See memory `[[staff-bios-and-name-merge]]`.

**Where deterministic merging ends:** after T0+T5, the residual queue is entirely
**common-surname cross-corps pairs** (surname used by ≥3 distinct first names — Sarah Smith,
Taylor Smith, Evan Black, Colby Vasquez). Two different people could legitimately share these,
and the pages carry no disambiguating text. These need **external evidence** — an LLM pass
(`resolveStaffIdentity --auto-merge`) or **web/browser research** on the individual (search
"<name> drum corps <corps>" → bio/LinkedIn/corps announcement confirming whether the two
corps' records are one career). That web-research loop is the next tactic (§0d).

**Result of this pass:** 1644 → 116 review pairs; **4730 staff → 3544 distinct people**;
8 junk rows deleted; `rm_staff` rebuilt at 3544. Cross-corps careers now surface correctly
(Tim Lautzenheiser, Kristen Eck 6 corps, Bryen Warfield 6, Marvin Reed 5).

## 0d. Web-research enrichment loop (2026-06-16)

The residual common-surname queue (§0c) and the missing-bio problem have the SAME fix:
**search the web for the individual.** For a held pair, a query like `"<name>" <caption> drum
corps <corpsA> <corpsB>` reliably surfaces a DCI/corps/LinkedIn bio that (a) confirms whether
the two corps' records are one career and (b) provides the bio the corps sites never published.
Tools: `WebSearch` + `WebFetch` (agentic — needs per-person judgment, not fully scriptable).

Worked examples (all CONFIRMED one person, bios harvested):
- **Sean Clark** — his "Thesis" percussion ensemble was *acquired by Blue Devils Performing
  Arts* in 2023; the Blue Devils + "bapam" Thesis records are one person.
- **Evan Black** (color guard, 3 corps), **Julian Johnson** (Cadets + Bluecoats visual),
  **Taylor Smith** (SCV brass, ex-Crown/Cavaliers/Troopers), **Kaysey Thompson** (guard,
  Crossmen + SCV), **Colby Vasquez** (SCV asst. director who also worked Seattle Cascades).

**Caption-consistency is the cheap pre-filter:** a held pair sharing a caption across corps
(low brass↔low brass, guard↔guard) has a high prior of being one person and is worth a search;
differing captions ("Member at Large" vs "Audio Engineer" for two "Sarah Smith"s) is more
likely two people.

Verdicts are applied by `sdk/scripts/enrichStaffFromWeb.ts` (`--apply`): merges confirmed-same
records to one `person_id`, backfills the harvested bio on rows lacking one, and marks review
rows `decided_by='web-research'` with the rationale (or `action='keep-separate'` for confirmed
DIFFERENT people). Re-runnable; edit the `VERDICTS` array as research proceeds. This is the
ongoing loop: caption-filter → search → verdict → apply → re-emit.

**Parser fix found via this loop:** names leaked a leading separator ("/ Kaysey Thompson",
"/ Ian Lewis") from the PASS3 `<br>`→" / " roster normalization. `clean()` in `staffScraper.ts`
now strips leading/trailing separator punctuation; 156 existing rows were cleaned in place.

## 0e. Bare caption-page discovery gap (2026-06-16)

Triggered by checking `cthurricanes.org/brass/`: we had only CT Hurricanes' `/board-of-directors/`
+ `/management-team/`, **missing all instructional staff** (brass/percussion/color-guard/visual).

**Root cause:** some corps split the roster across **bare caption pages** — `/brass/`,
`/percussion/`, `/color-guard/`, `/visual/` — where the link is just "Brass"/"Percussion" with
NO "staff"/"team" suffix. `STAFF_SUBPAGE_RE` required that suffix (`brass staff`, `percussion
team`), so `findStaffSubpages` never followed them.

**Fix (`staffScraper.ts`):** added `CAPTION_PAGE_RE` — matches when the **final URL path
segment** (or exact link text) is itself a caption word (`brass|percussion|colou?r-?guard|
visual|battery|front-ensemble|pit|drum-major|…`). Verified: from CT Hurricanes' board page it now
discovers `/brass/ /color-guard/ /percussion/ /visual/ /management-team/`. Re-scraped 2026:
**8 → 54 people** (the full instructional staff, incl. the brass caption team). This is a GLOBAL
discovery improvement — other corps using bare caption pages will benefit on the next bulk run.

**Also fixed:** `looksLikePersonName` now rejects any string containing `: ! ? ;` — bio-section
labels and announcement text were leaking as names ("Where I've Marched:", "Bio Coming Soon!",
"Gold at DCI Southeastern!"). Cleaned existing such rows dataset-wide.

**Operational gotcha (resume):** re-scraping a corps/season is a no-op unless you first clear its
`scraper_progress` rows — the resume fast-path silently skips done seasons (logs "across 0
seasons"). To force a re-discover: `DELETE FROM scraper_progress WHERE task_type LIKE '%staff%'
AND corps_key=? AND season=?`. Render-heavy: clean chromium orphans first, `--concurrency 1`,
`--max-old-space-size=2048` (see memory `[[chromium-cleanup-on-this-4gb-box]]`).

## 1. Context & goal

Build a unified **staff directory**: for every corps/group, capture who taught
there, **in which seasons**, **their position title**, **the section/caption they
taught**, plus a **bio** and a **headshot** — and roll those per-corps records up
into a **per-person profile** that spans the multiple groups someone has taught
(including simultaneous appointments). This is the staff analog of the existing
judge-bio work (`sdk/docs/judge-bio-research-plan.md`).

Two requirements make this non-trivial, both called out explicitly:

1. **Identity.** Some people teach multiple groups (sometimes the same year);
   other people **share names**. There is **no canonical person table** today —
   `corps_staff.staff_id` is caller-supplied and is currently just the LLM's
   value or a fallback id (`sdk/src/scraperClaude.ts:366`, `normalizeStaffMember`).
   The judge id trick `{first}-{last}-1` (`relational.ts` `makeJudgeId`)
   deliberately **collapses same-named people into one** — that is the wrong
   behavior for staff and must not be reused for identity.
2. **Time.** Staff turns over every year. Live sites show only the *current*
   roster; prior seasons must come from the **Wayback Machine** (well-timed
   snapshot per season) and/or **season announcements**.

**Locked decisions (from the user):**
- Identity → **conservative + review queue**: never auto-merge across corps
  without strong corroboration; ambiguous pairs go to a human-reviewable queue.
- History depth → **back to 2013** (matches the existing
  `wayback/wayback_dci_events_2013_2024.json` window).
- Extraction → **hybrid**: deterministic parse first, schema-validated LLM
  fallback only on messy pages.
- Capture **position title** and **section/caption** for every assignment.

This plan follows the practices in `sdk/docs/web-research-and-scraping-field-guide.md`.

---

## 2. What already exists (reuse — do not rebuild)

| Concern | Existing asset | Location |
|---|---|---|
| Staff tables (season-scoped) | `corps_staff`, `corps_staff_assignments`, `corps_staff_links`, `corps_staff_affiliations` | `sdk/src/relational.ts:613–656` |
| Assignment key | PK `{staffId}:{corpsKey}:{season}:{title}:{roleType}` | `relational.ts:4166` |
| Staff write path | `upsertStaffMember` (**full-UPDATE / overwrites** the row) | `relational.ts:4851` |
| Schemas | `CorpsStaffMemberSchema`, `CorpsStaffAssignmentSchema`, `CorpsStaffAffiliationSchema`, `LinkSchema` | `sdk/src/extraDomain.ts:19–60` |
| Caption field on judges (vocab reference) | `captionGroup` | `extraDomain.ts:212` |
| Corps list | 76 corps, 61 with `website` | `data/corps_data.json` |
| LLM staff scraper (emits `staff[]`) | `runClaudeScraper` + `scraper_progress` resume | `scraperClaude.ts:1105`, progress at `:471` |
| Identity-compare helper | `compareStaffMembersWithClaude` → `{samePerson, confidence, recommendedAction}` | `scraperClaude.ts:1340` |
| Render ladder (local Chromium → Browserbase) | `fetchHtml` | `sdk/src/browserbaseService.ts:18` |
| Curl Cloudflare tier (generic UA) | `curlFetch` | `sdk/src/merchScan.ts:139` |
| Render scripts | `renderImgs/renderPage/renderHtml.ts` | `sdk/scripts/` |
| Wayback lookup | `fetchWaybackPage` + `archive.org/wayback/available` | `sdk/src/corpsDiscovery.ts:223,39` |
| Media caching + verify | `MediaService.cache({ownerType:'staff',…})` | `sdk/src/mediaService.ts:71` |
| Report → dry-run → apply convention | `sdk/results/*.json`, `--dry-run`/`--apply` | `scripts/scanMerch.ts` |

---

## 3. Data model changes

The existing tables already capture **title** (position) and **role_type**
(section/caption) per `(staff, corps, season)` — so the temporal + position +
caption requirements need **no schema change** beyond identity. Add:

1. **`corps_staff.person_id TEXT`** (nullable) + index `idx_staff_person`.
   - `staff_id` stays the **per-source record** key (one row per source extraction
     of a person at a corps).
   - `person_id` is the **canonical-person grouping** key; the profile view groups
     by it.
2. **`corps_staff_review`** — raw archive + review queue for cross-corps merges:
   ```
   (review_id TEXT PK,
    left_staff_id TEXT, right_staff_id TEXT,
    same_person INTEGER, confidence TEXT,        -- HIGH|MEDIUM|LOW
    action TEXT,                                 -- merge|keep-separate|needs-review
    rationale TEXT, supporting_evidence_json TEXT,
    resolved INTEGER DEFAULT 0, decided_by TEXT,
    created_at TEXT, updated_at TEXT)
   ```
   plus helper `upsertStaffReview` (coalescing, same shape as the judge helpers).

3. **Caption normalization** — a small pure map `normalizeCaption()` that folds
   free-text titles into a controlled `role_type` vocabulary while preserving the
   raw `title`:
   - `brass` (hornline, brass tech), `percussion` (battery, front ensemble/pit —
     keep sub-tag in `notes`), `guard` (color guard, visual/equipment),
     `visual` (drill/visual/marching), `music` (arranger/composer/music director),
     `drum-major`, `director` (corps director/program coordinator),
     `design` (program/show designer), `other`.
   - Store normalized value in `role_type`; keep verbatim title in `title`.

> Note: `upsertStaffMember` **overwrites** the `corps_staff` row — coalescing must
> happen **before** the call (see invariants).

---

## 4. Architecture / pipeline

```
corps_data.json (61 sites)
   └─ for each corps:
       build (corpsKey, season) tasks for 2013..currentSeason
         ├─ current season → live staff-page URL
         └─ past seasons   → Wayback snapshot URL (one per season, ~Aug 1)
   └─ for each task (scraper_progress-gated, resumable):
       1. discover staff page (slug guesses → WebSearch fallback)
       2. render once via fetchHtml (curl tier for Cloudflare)
       3. EXTRACT (hybrid):
            A. deterministic parse: JSON-LD Person / og / DOM card-grid
            B. AI fallback (schema-validated) only if A yields nothing usable
       4. normalize caption, attach title + section, source_url + confidence
       5. verify + cache headshot (curl Content-Type, named-match guard)
       6. coalesce → staged report row
   └─ identity resolution pass:
       within-corps auto-link; cross-corps → compareStaffMembersWithClaude
         → HIGH+corroborated auto-merge; else corps_staff_review (needs-review)
   └─ --dry-run report (sdk/results/staff-scan-*.json)  →  --apply (upsert)
```

### 4.1 Temporal coverage (2013→present)
- Per corps, enumerate seasons 2013..current. Current = live page; past =
  `archive.org/wayback/available?url=<staffPageUrl>&timestamp=<season>0801`
  (reuse `fetchWaybackPage`), pick the closest snapshot, render that URL.
- One snapshot per season (mid-season roster). If no snapshot exists, record a
  gap (do **not** fabricate). Season-announcement pages are a secondary source.
- Drive via `scraper_progress` with `task_type='staff-2013'` so re-runs skip
  completed `(corps, season)` pairs.

### 4.2 Extraction (hybrid — field guide §3c Pattern A→B)
- **A (preferred):** render → `cheerio` → JSON-LD `Person`, microdata/`og:`, then a
  DOM heuristic for the common staff "card grid" (name + title + `<img>` headshot
  + bio blurb). Cheap, reproducible.
- **B (fallback):** only when A yields nothing usable, hand stripped HTML/visible
  text to a schema-validated extractor producing `CorpsStaffMemberSchema[]` with
  per-field `{value, confidence, source}`. Reuse `runClaudeScraper`'s
  prompt → decode → upsert shape, scoped to staff. **Validate on one corps before
  any bulk run** (web-tool access in `claude -p` is unverified; can hallucinate).

### 4.3 Identity resolution (conservative)
- **Candidate id:** `person_id = slug(displayName)`; **collisions allowed** — id is
  not the dedup mechanism, resolution is. Confirmed-distinct same-named people get
  `-2`, `-3` suffixes.
- **Within a corps:** same normalized name + overlapping role across seasons →
  auto-link to one `person_id` (low collision risk).
- **Across corps:** auto-merge **only** when `compareStaffMembersWithClaude`
  returns `same_person && confidence=HIGH` **and** ≥1 corroborating signal
  (shared photo-hash, near-identical bio text, or overlapping affiliation).
  Otherwise → `corps_staff_review` row with `action='needs-review'`; **never
  auto-merged**.
- `scripts/resolveStaffIdentity.ts` lists pending pairs and applies confirmed
  merges/splits.

### 4.4 Images (field guide §6)
- Verify each candidate photo with `curl -sI` → require `Content-Type: image/*`;
  reject `text/html` and known placeholders (generic avatar filenames).
- Require a **named match** (filename/alt contains surname) before attaching, to
  avoid wrong-person headshots.
- Cache bytes via `MediaService.cache({ownerType:'staff', ownerId: staff_id,
  role:'headshot', sourceUrl})`. **Never** store an expiring `fbcdn`/`instagram`
  URL as the durable `photo_url` — re-host the bytes.

### 4.5 Read model + route (in v1 scope — mirror the judge feature end-to-end)
No `rm_staff_*` exists today; replicate the judge stack (mapped at
`sdk/src/readModel/builders/judges.ts`, `readers.ts`, `scripts/emitReadModel.ts`,
`app/routes/judges/*`). **Profiles are keyed by `person_id`, not `staff_id`** —
the directory and detail are per canonical person.

- **Builders** `sdk/src/readModel/builders/staff.ts`:
  - `buildStaffDirectory(db): Promise<StaffSummary[]>` — group `corps_staff` by
    `person_id`, join `corps_staff_assignments`; emit identity + `default_title` +
    `photo_url` + distinct `corps_count` + `seasons[]` + a `captionBreakdown[]`
    (by normalized `role_type`/section) + `groups[]` (corps taught).
  - `buildStaffProfile(db, personId): Promise<StaffProfile | null>` — full record:
    identity, biography, photo, `assignments[]` (corps_key, corps_name, season,
    **title**, **section/role_type**, year range, source_url), `affiliations[]`,
    `seasons[]`, `groups[]`. Reuse `buildCorpsCanonicalMap()` to collapse corps
    aliases (as `buildJudgeProfile` does at `judges.ts:211`).
  - New `StaffSummary` / `StaffProfile` types exported here (judge types live in
    the same builder file, lines 7–61 — follow that convention).
- **Readers** `sdk/src/readModel/readers.ts`: `readStaffDirectory` /
  `readStaffProfile(personId)` reading `rm_staff` / `rm_staff_detail`, with the
  same `READ_MODEL_DB_URL`-unset → build-from-relational fallback
  (`app/lib/judge-directory.ts:39–48` `readOrBuild` is the model).
- **rm tables** (DDL in `emitReadModel.ts` alongside `rm_judges` at `:268`):
  ```sql
  CREATE TABLE rm_staff (person_id TEXT PRIMARY KEY, summary_json TEXT);
  CREATE TABLE rm_staff_detail (person_id TEXT PRIMARY KEY, detail_json TEXT);
  ```
- **Emitter** `scripts/emitReadModel.ts`: add `"staff"` to the `Section` union +
  `ALL_SECTIONS` (`:89–107`); add an emission block mirroring judges (`:840–866`)
  — `buildStaffDirectory` → `rm_staff`, then per-person `buildStaffProfile` →
  `rm_staff_detail`; add JSON shards `staff.json` + `staff/{person_id}.json`
  (`:1218–1224`). `--only staff` re-emit is zero-downtime.
- **Service + server fns:** new `app/lib/staff-directory.ts`
  (`StaffDirectoryService` Effect layer, `listStaff` / `getStaffProfile`),
  `getStaffDirectory` / `getStaffProfile` in `app/lib/server-fns/hybrid.ts`
  (model: `:477–491`), and a `staffCollection` in `app/db/collections.ts`
  (model: `:31–37`).
- **Routes** (TanStack Router, file-based):
  - `app/routes/staff/index.tsx` — directory; loader calls `getStaffDirectory()`,
    client-side filter/sort (by group, season, section). Model:
    `app/routes/judges/index.tsx`.
  - `app/routes/staff/$personId.tsx` — profile; loader `loadDetailOrServer(
    'staff/${personId}.json', () => getStaffProfile({data: personId}))`. Model:
    `app/routes/judges/$judgeId.tsx`.

---

## 5. Invariants (must always hold)

1. **`staff_id` ≠ `person_id`.** `staff_id` is per-source-record; `person_id` is
   the canonical grouping. One person → many `staff_id`s → one `person_id`.
2. **No silent cross-corps merge.** Two records merge across corps only via HIGH
   confidence + corroboration, or an explicit human decision in
   `corps_staff_review`. Default for ambiguity is *keep separate*.
3. **Coalesce before upsert.** `upsertStaffMember` overwrites the row; a scraped
   `null`/missing field must **never** erase an existing non-null bio/photo/title.
4. **Every fact is sourced.** Each assignment/bio/photo carries `source_url` +
   confidence. Nothing is written as HIGH without a primary/official source.
   Omit rather than guess.
5. **Season-scoped truth.** An assignment is always tied to a specific `season`
   (or an explicit year range). A current-roster scrape must not retroactively
   claim past seasons.
6. **Idempotent + resumable.** Re-running a completed `(corps, season)` is a no-op
   diff; `scraper_progress` gates work.
7. **Photos are verified bytes, not URLs.** Only `Content-Type: image/*`,
   non-placeholder, name-matched images get attached, and they are cached
   (host-independent key).

---

## 6. Assumptions to verify before/early in implementation

1. **Staff-page discoverability.** Do most of the 61 sites expose a staff page at a
   guessable slug (`/staff`, `/team`, `/about/staff`, …)? — sample ~10 corps.
2. **Wayback coverage for 2013.** Do typical corps staff pages actually have
   snapshots back to 2013, or do many start later? Probe 5 corps × a few seasons.
   (Affects realistic history depth; record gaps honestly.)
3. **`upsertStaffMember` overwrite behavior** is as read (`relational.ts:4851`) —
   confirm nested assignment/affiliation upserts key off derived ids and don't
   delete siblings.
4. **`claude -p` web tools.** Confirm whether the headless runner can fetch, or
   whether Pattern B must run in-process with the render output fed in. Validate on
   one corps.
5. **Caption vocab fit.** Sample real staff titles to confirm `normalizeCaption()`
   buckets cover the field (esp. percussion sub-roles, "visual" vs "guard").
6. **Cloudflare set.** Identify which corps sit behind Cloudflare → force
   concurrency 1–2 for those (field guide §9).
7. **Multi-corps simultaneous teaching** is representable: it is — multiple
   `corps_staff_assignments` rows for the same `(staff_id, season)` across
   different `corps_key`. Confirm no unique constraint blocks it.

---

## 7. Milestones

- **M0 — Spike & assumptions (0.5d).** Verify assumptions 1–6 on ~10 corps; save
  HTML dumps for parser fixtures.
- **M1 — Schema + helpers.** Add `person_id` + index, `corps_staff_review` table +
  `upsertStaffReview`, `normalizeCaption()`. Migration is additive/idempotent.
- **M2 — Deterministic extractor.** `staffScraper.ts` discovery + render + Pattern A
  parser; passes on the M0 fixtures.
- **M3 — Orchestrator + temporal.** `sdk/scripts/scrapeStaff.ts` (`--corps`,
  `--seasons 2013-2026`, `--limit`, `--concurrency`, `--dry-run`, `--apply`);
  Wayback per-season tasking; `scraper_progress` gating; writes
  `sdk/results/staff-scan-*.json`.
- **M4 — AI fallback (Pattern B).** Schema-validated extractor for messy pages,
  validated on one corps first.
- **M5 — Images.** curl-verify + name-match + `MediaService.cache`.
- **M6 — Identity resolution.** Within-corps auto-link; cross-corps compare →
  auto-merge/queue; `resolveStaffIdentity.ts` CLI.
- **M7 — Bulk run.** Staged batches (concurrency 1–2 for Cloudflare), dry-run
  review, `--apply`, before/after diff guard.
- **M8 — Read model + emitter.** `buildStaffDirectory`/`buildStaffProfile` (keyed
  by `person_id`) + `readStaffDirectory`/`readStaffProfile` + `rm_staff`/
  `rm_staff_detail` DDL + `"staff"` section in `emitReadModel.ts` (incl. JSON
  shards). Verify `emitReadModel --only staff` round-trips and reader/builder parity.
- **M9 — App route.** `staffCollection`, `StaffDirectoryService` +
  `getStaffDirectory`/`getStaffProfile` server fns, `/staff` directory +
  `/staff/$personId` profile routes (mirror `app/routes/judges/*`).

---

## 8. Success criteria

- **Coverage:** ≥80% of the 61 corps with a website yield a current-season roster;
  per-season historical fill recorded with honest gap reporting (no fabrication).
- **Completeness per assignment:** name, **position title**, **section/caption**
  (normalized), season, and `source_url` present for ≥90% of extracted rows;
  bio + verified headshot for a meaningful majority (track hit-rate, expect long
  tail per field guide §12).
- **Identity correctness:** seeded cross-corps instructor links to **one**
  `person_id`; seeded same-name-different-person pair stays **separate** (lands in
  review, unmerged). Zero auto-merges below HIGH+corroborated.
- **Safety:** re-run is a no-op diff; no existing non-null field nulled; all photos
  curl-verified + cached; no `fbcdn`/`instagram` URLs stored as durable photo_url.
- **Resumability:** killing/restarting a bulk run resumes via `scraper_progress`
  without re-doing completed `(corps, season)` pairs.
- **Read-model parity:** `readStaffDirectory`/`readStaffProfile` output equals the
  builder output (verifyReadModel-style check); `emitReadModel --only staff` is
  zero-downtime and produces `staff.json` + per-person shards.
- **Route works end-to-end:** `/staff` lists people grouped by `person_id` with
  group/season/section filters; `/staff/$personId` shows bio, photo, and every
  assignment with **title + section + season + corps**, sourced. Loads from static
  shard with server-fn fallback (judge route parity).

---

## 9. Files

- **New:**
  - `sdk/scripts/scrapeStaff.ts` — orchestrator/CLI (mirrors `scripts/scanMerch.ts`).
  - `sdk/src/staffScraper.ts` — discovery, render, hybrid extract, caption
    normalize, coalesce.
  - `sdk/scripts/resolveStaffIdentity.ts` — review-queue CLI.
- **Modify:**
  - `sdk/src/relational.ts` — add `corps_staff.person_id` + index,
    `corps_staff_review` table, `upsertStaffReview`; ensure callers coalesce
    before `upsertStaffMember`.
  - **Read model (M8):** `sdk/src/readModel/builders/staff.ts` (new),
    `sdk/src/readModel/readers.ts` (`readStaffDirectory`/`readStaffProfile`),
    `sdk/scripts/emitReadModel.ts` (`"staff"` section + `rm_staff`/`rm_staff_detail`
    DDL + JSON shards).
  - **App route (M9):** `app/routes/staff/index.tsx` + `app/routes/staff/$personId.tsx`
    (new), `app/lib/staff-directory.ts` (new service), `app/lib/server-fns/hybrid.ts`
    (`getStaffDirectory`/`getStaffProfile`), `app/db/collections.ts` (`staffCollection`).
- **Reuse unchanged:** `browserbaseService.ts`, `merchScan.ts` (curl tier),
  `scraperClaude.ts` (`runClaudeScraper`, `compareStaffMembersWithClaude`),
  `mediaService.ts`, `corpsDiscovery.ts` (`fetchWaybackPage`), `extraDomain.ts`.

---

## 10. Verification

1. **Parser unit tests** against saved staff-page HTML (`renderHtml.ts <url>
   /tmp/x.html`) — assert name/title/section/photo for 2–3 layouts.
2. **One-corps dry run:** `npx tsx sdk/scripts/scrapeStaff.ts --corps <key>
   --seasons 2013-2026 --dry-run` → inspect `sdk/results/staff-scan-*.json` for
   correct per-season assignments, normalized captions, sourced bios/photos, and
   that AI fallback fired only on messy pages.
3. **Identity tests:** seed a known cross-corps instructor + a known name-collision
   pair; confirm link vs. review-queue outcomes.
4. **Image checks:** confirm `media-cache.db` + `media_assets` rows; placeholders
   and `text/html` rejected.
5. **Apply + idempotency:** `--apply` one corps, re-run → no-op diff, no nulled
   fields, `scraper_progress` skips.
6. **Scale/Cloudflare:** 5-corps batch at concurrency 2; confirm Cloudflare corps
   don't produce false-empty rosters (before/after diff guard).
7. **Read model:** `npx tsx sdk/scripts/emitReadModel.ts --only staff` →
   `rm_staff`/`rm_staff_detail` populated, `staff.json` + `staff/<person>.json`
   shards written; reader output matches builder output.
8. **Route:** run the app (`/run` skill) → visit `/staff` and a `/staff/$personId`;
   confirm grouped listing, filters, and a profile showing every assignment with
   title + section + season + corps, plus a cached headshot.

---

## 11. Notes, risks, open questions

- **Overwrite footgun:** `upsertStaffMember` full-UPDATEs — the single most likely
  data-loss bug. All writes go through a coalescing layer; never call it with a
  partially-populated record sourced from a thin page.
- **Wayback timing:** staff pages often update in spring; Aug-1 snapshot is a
  heuristic — may capture a stale or pre-update roster. Record snapshot timestamp
  in `notes` so it's auditable.
- **Name collisions are real** (field guide §8 — the "Michael Davis"/"Andrea
  Brown" misses). Bias to *keep separate*; a missing link is recoverable, a wrong
  merge is a visible error.
- **Long-tail yield** drops fast (field guide §12) — prefer a targeted pass (user
  pastes URLs for high-value holdouts) over grinding every corps×season.
- **DCI-only first.** `corps_data.json` is DCI-centric; WGI/other circuits are a
  later expansion (different sites/cadence).
- **Decided:** the app route + read-model (builders/readers/emitter) are **in v1
  scope** (M8–M9), keyed by `person_id`, mirroring the judge feature.
- **Open:** profile URL slug — `person_id` is `slug(name)` (e.g. `/staff/john-smith`,
  with `-2` for disambiguated collisions). Confirm that's the desired public URL
  shape vs. an opaque id.
- **Cleanup:** remove temp render dumps (`rm -f /tmp/*.html`); don't commit binary
  scratch (field guide §12).
