# Staff Listing Quality Plan — bios, photos, structured bio-mining (2026-06-17, rev. 2)

Builds on `staff-scraping-plan.md`, `announcement-sources-plan.md`, the yearbook work
(`[[dci-yearbooks-authoritative-staff]]`), the merge-by-default policy (`[[staff-bios-and-name-merge]]`),
and **reuses the judge bio pipeline** (`judge-bio-research-plan.md` + `scripts/researchJudges.ts`).

## Where we are (measured 2026-06-17)
- **9,882 people / 29,749 assignments** (web + Wayback + announcements + DCI roundups + 9 yearbook
  seasons), merge-by-default.
- **Bios: 398 people (~4%). Photos: 1,197 (~12%).** Bios are free text — no structured facts.
- **895 people taught ≥3 corps** (the prominence tier for S2).

## Ground truth about the existing schema/read-model (so we extend, not duplicate)
- `corps_staff(staff_id, given_name, family_name, display_name, default_title, biography,
  photo_url, metadata_json, person_id)` — **bio/photo are per `staff_id`** (one row per corps×person),
  NOT per person.
- `rm_staff_detail` builder **already** (`src/readModel/builders/staff.ts`): picks the *representative*
  row per `person_id` (photo > bio > title), and **already surfaces a career panel** —
  `corps_count`, `seasons[]`, `assignments[]` (per-corps roles). ⇒ The "taught where/when" structure
  EXISTS via assignments; S3 must NOT re-derive it. And **filling a bio/photo on ANY one of a
  person's `staff_id` rows is enough** — the read model surfaces the richest.
- `corps_staff_affiliations(affiliation_id, staff_id, related_corps_key, relation_type, notes,
  since_season, through_season)` — **EXISTS, 0 rows.** The home for mined *non-assignment* relations
  (groups MARCHED with, or taught groups not in our `corps` table).
- No bio-facts/education/award tables yet (need one new table).
- Judge precedent: `ExtraDomain.JudgeProfileSchema {biography, photoUrl, alternateNames[],
  externalLinks[], corpsRelations[], seasonHighlights[], media[]}` + `researchJudges.ts` (WebSearch/
  WebFetch, per-fact confidence HIGH/MEDIUM/LOW, image byte-caching, dry-run→apply, `--top N`).

## Principles (carry forward — they're why prior phases worked)
1. **Deterministic-first + AI fallback** (hybrid), every extractor.
2. **GROUND everything** — a name/fact must appear in a fetched source; verify+cache photos
   (`verifyImageUrl` → `MediaService.cache`); never store expiring CDN URLs raw.
3. **Provenance + confidence** per field (`kind`, `source_url`, `confidence` HIGH/MEDIUM/LOW,
   `decided_by`); **fill-if-empty**; override only for higher authority.
4. **Authority order**: yearbook (caption/title) > corps detail page > announcement > web-research >
   social. Bios: richest, most-official wins; never overwrite a verified bio with a weaker one.
5. **Ops** (4 GB box): concurrency 1–2, harness background mode (NOT `nohup &`), reap `opencode
   serve` leaks, `mergeByNameDefault.ts --apply` after any identity-touching ingest.

---

## S1 — Raise base bio/photo coverage by SCRAPING harder (cheap, deterministic)

The roster scraper stops at the grid; the bios/photos are often one click deeper.

**S1.1 Per-person detail pages.** Extend discovery: when a roster card links to a same-host
person URL (name-slug, `/staff/<name>`, Wix `/team/<name>`, WP author/permalink), fetch+extract the
detail bio + larger headshot. New `links.kind='detail-page'`. Bounded per corps, cached, resumable.
- Add `findPersonDetailLinks(html, baseUrl)` (sibling of `findStaffSubpages`) — anchors whose
  href/text match a roster name; pair to the person by name.
**S1.2 WordPress REST bios.** Where the corps is WP, `/wp-json/wp/v2/posts?search=<surname>` and
team/author endpoints carry bio HTML + `featured_media` — no render. Reuse the REST discovery from
`discoverAnnouncementPosts`.
**S1.3 Photo hardening.** Prefer detail-page headshot > grid thumb; strip WP `-WxH` suffix → original;
`verifyImageUrl` (Content-Type image/*, reject placeholders "TBH"/"HW SUN"/"Image-empty-state");
require name-matching filename OR detail-page context (anti wrong-person). Cache bytes via
`MediaService` (`ownerType:'staff', ownerId:staff_id, role:'headshot'`).
**S1.4 Re-mine cached announcement HTML** for the bios/photos we skipped on `<2-person` and
single-person "X joins" posts.
- **Coalesce:** fill-if-empty on the person's representative `staff_id`; never null an existing bio.
- **Edge cases:** lazy-img `data-src`; expiring fbcdn/IG URLs (cache only); placeholder headshots
  shared by ≥2 names (the T1 placeholder set already computed in `testMergeTactics`); detail page that's
  a generic corps blurb (require the person's name in the text); Cloudflare corps → tunnel render (S2).
- **Script:** `scripts/scrapeStaffDetail.ts` (`--corps`, `--limit`, `--dry-run`/`--apply`, report).
- **Milestone S1 (metrics):** bios **~4% → ≥25%**, photos **~12% → ≥35%**; 0 wrong-person photos in a
  50-sample audit; report of detail-pages found/extracted per corps.

## S2 — Prominence-ranked agentic enrichment (MIRROR `researchJudges.ts`)

For the people who matter most, fetch bio+photo from the open web. **Clone the judge pipeline**, don't
rebuild it.

**S2.1 Prominence score** (`person_id`): `2·distinctCorps + 1.5·(captionHead|director|designer roles)
+ seasons + recencyBonus + newsMentions`. 895 have ≥3 corps; rank, work top-down to a budget.
**S2.2 Two search engines (both bypass the datacenter-IP blocks):**
- Agent **`WebSearch`/`WebFetch`** (off-box, no CAPTCHA) — primary harvest (corps staff page,
  LinkedIn, school faculty, DCI/WGI articles, Hall of Fame). This is how `enrichBiosByPersonId.ts`
  got the 12 prominent bios and how `researchJudges.ts` works.
- **`browser-tools` over the Tailscale tunnel** (residential IP) for datacenter-blocked / JS-rendered
  pages (`search`, `content`, `nav`) — `[[tailnet-mini-pc-reverse-tunnel]]`, `harvestSearchSeeds.ts`.
**S2.3 Synthesize + ground + disambiguate.** Write a concise factual bio with a source URL + confidence;
extract a headshot (verify+cache). The model may assert ONLY facts present in a fetched source.
**Disambiguation guard:** confirm the source is the SAME person (corps/role/era match the DB) before
attaching — a prominent name can be shared; don't enrich the wrong "Mike Scott".
**S2.4 Apply** via the `enrichBiosByPersonId.ts` pattern (person_id-keyed, fill-if-empty,
`decided_by='web-research'`, busy-timeout), with a `StaffProfileSchema` analog to `JudgeProfileSchema`.
- **Script:** `scripts/researchStaff.ts` (`--top N`, `--corps`, `--allowed-tools WebSearch,WebFetch`,
  `--tunnel`, byte-cache photos, dry-run→review→apply) — copy `researchJudges.ts`, swap judge→staff.
- **Edge cases:** shared names (guard); paywalled/blocked (tunnel); conflicting sources (corps-official
  > school > social); expired social photos (cache only); cost (budget by prominence, batch+checkpoint).
- **Milestone S2:** bio+photo for the top ~895 (≥3-corps) people, then extend by budget; per-person
  source+confidence recorded; report prominence-weighted coverage (target ≥90% of top-200).

### S2 — IMPLEMENTED TACTIC (2026-06-17): subagent fan-out + free-tier orchestration

Two interchangeable research tiers feed ONE ingest (`scripts/applyStaffResearch.ts` →
`staff_profile_candidates`, `source_kind='web-research'`, verify+cache photo, dated current).

**Tier A — Claude subagent fan-out (high quality, costs Claude tokens).**
1. Rank targets: `SELECT … HAVING count(distinct corps_key)>=3 AND no-bio ORDER BY corps,seasons`
   → `results/staff-research/_targets.json`; slice into `_input-N.json` (~10 each).
2. Dispatch N `general-purpose` subagents in ONE message (parallel). Each: Read its slice,
   WebSearch+WebFetch per person, **GROUND** (source must name the marching arts + a listed
   corps/role, else `confidence:"LOW"` → skipped — never guess), write `batch-N.json`
   `{person_id,display_name,bio,photo_url,sources[],confidence}`. Subagents keep all search
   output OUT of the main context (the whole point — orchestrator never sees the noise).
3. `applyStaffResearch.ts --apply`. First run: 60 people → 57 bios + 31 photos; 3+ corps tier
   bio 14%→20%, photo 29%→31%. Repeatable: regenerate `_targets` at an offset, redispatch.

**Tier B — opencode/deepseek-v4-flash-free (cheap; hand-hold + give it tools).** deepseek has
NO web access, so the orchestrator (`scripts/researchStaffViaOpencode.ts`) IS its toolbelt:
it fetches source text (DuckDuckGo-HTML no-key search → node-fetch top results, strip to text)
and hands it to `opencodeComplete()` (staffAiExtract.ts) with a strict-JSON grounding prompt;
code-side re-grounds (surname + a corps token must appear) before writing the same `batch-*.json`
shape. Use Tier B to scale cheaply once Tier A validates quality; same ingest, same grounding,
same candidate store. Watch the opencode-serve leak (reap per [[chromium-cleanup-on-this-4gb-box]]).

## S3 — Mine bios → structured facts (deterministic parser + AI fallback)

Turn bio prose into queryable facts. **Method (as requested):** dump 50–100 real bios → find the
recurring shapes → write a deterministic parser → add an AI hybrid for the irregular ones.

**S3.1 What to extract (only what assignments DON'T already give):**
| Fact | Store |
|---|---|
| `education[]` (degree, institution, year) | new `staff_bio_facts` (person_id-keyed) |
| `performed[]` (corps MARCHED + years) | `corps_staff_affiliations` `relation_type='performed'` (map corps via `mapCorps`; unknown→facts) |
| `taughtOther[]` (groups taught NOT in our corps set, e.g. HS/indoor) | `corps_staff_affiliations` `relation_type='taught'` |
| `awards[]` (DCI/WGI titles, Jim Ott, Fred Sanford, Hall of Fame + year) | `staff_bio_facts` |
| `currentPosition`, `instruments`/`specialty`, `hometown` | `staff_bio_facts` |
(The "taught DCI corps + seasons" is ALREADY in `assignments`/`rm_staff_detail` — don't duplicate it.)

**S3.2 Deterministic parser** `scripts/../bioFactsParse.ts`: clause-split + matchers built from the
observed corpus — degrees (`B\.?M\.?E?\.?|M\.?M\.?|D\.?M\.?A\.?|Ph\.?D\.?` + institution + year),
`(marched|performed|aged out) … <Corps> \(?YYYY(-YYYY)?\)?`, `won/earned … <Award>`, `currently …`.
**Ground** corps against the `corps` table + alias map, institutions against a school list, awards
against a known-award list — reject unmatched (the anti-hallucination lesson). Confidence by match
specificity.
**S3.3 AI fallback** `bioFactsExtractAI.ts`: hybrid like `extractProfile` — deterministic-first,
escalate to the **claude→codex→opencode(deepseek-v4-flash-free)** ladder (`extractWith` + schema +
`groundStaff`-style grounding) when deterministic coverage looks low for the bio's length.
**S3.4 Feedback loop:** mined `performed[]`/award years can fill `assignment` seasons; shared
education/award sentences are strong same-person evidence → feed `testMergeTactics` T2 (bio-overlap)
to catch merges name-matching missed.
- **Edge cases:** corps name variants (reuse `mapCorps`); year ranges vs singletons; "aged out" =
  last performing year; board/admin bios (sparse facts OK); over-extraction (grounding); accented names.
- **Milestone S3:** parser validated on a **50–100 hand-labeled bio sample** (report precision/recall
  per fact type; target ≥0.9 precision, ≥0.7 recall before bulk); `staff_bio_facts` + affiliations
  populated; surfaced in `rm_staff_detail` (education/performed/awards/current panels); merge-evidence
  loop run.

---

## Read model / app
Extend `rm_staff_detail` + `/staff/$personId`: bio + photo (already rep-picked) **+ source/confidence
badges + a structured "career facts" panel** (education, performing history, awards, current position)
alongside the existing teaching-assignments panel. Add a `staff_bio_facts` reader; bump SCHEMA_VERSION.

## Dependencies & sequence
1. **S1** (cheap, deterministic) — biggest coverage lift first, enlarges the bio corpus for S3.
2. **S3 deterministic parser** — built/tuned on the now-larger corpus (S1 output).
3. **S2** — prominence enrichment fills the high-value gaps web/scrape can't (adds rich bios → more
   S3 fodder).
4. **S3 AI fallback + feedback loop**, then **re-emit** + `mergeByNameDefault.ts --apply`.
Each stage: `--dry-run` → report → `--apply`, additive upserts only, per the project convention.

## Risks
- **Wrong-person bio/photo** (shared names) — the disambiguation guard (S2.3) + name-grounding are the
  defense; audit a sample each run.
- **AI cost/credits** — claude outages happen (see the yearbook show-backfill); the opencode tier +
  budget caps + dry-run gating contain it.
- **Over-extraction in S3** — grounding against real corps/school/award lists; hand-labeled precision
  gate before bulk.
- **Authority regressions** — never let web-research overwrite a verified corps/yearbook value
  (fill-if-empty + authority order).
