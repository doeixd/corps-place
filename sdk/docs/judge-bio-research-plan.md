# Judge Biographical Research & Enrichment Plan

Status: **Proposed** — awaiting approval before execution.
Last updated: 2026-06-10

## 1. Goal

Collect biographical information, headshots/media, external links, and corps
affiliations for DCI adjudicators — starting with the **top 12 judges by
assignment count** — and ingest into the existing (currently empty) judge
profile tables. Make the process **repeatable** for the remaining ~231 judges.

## 2. What already exists (reuse, don't rebuild)

| Component | File | Notes |
|---|---|---|
| Judge profile schema | `judges` (`biography`, `photo_url`, `metadata_json`), `judge_links`, `judge_corps_relations`, `judge_highlights`, `media_assets` (`relational.ts`) | Full target shape already present. **All bios/photos currently NULL.** |
| Profile writer | `upsertJudgeProfile(sql, profile)` (`relational.ts:4582`) | Coalescing-friendly upsert of bio + links + relations + highlights + media in one call. |
| Domain schema | `ExtraDomain.JudgeProfileSchema` → `JudgeBioProfile` (`extraDomain.ts:230`) | Fields: `judgeId, displayName, givenName, familyName, biography, photoUrl, alternateNames[], externalLinks[], corpsRelations[], seasonHighlights[], media[]`. |
| Research pipeline | `runClaudeJudgeScraper(options)` (`scraperClaude.ts:1258`) | Aggregates judges → builds per-judge research prompt → `claude -p` subprocess → normalize → `upsertJudgeProfile`. Supports `dryRun`, `maxTasks`, `concurrency`, `targetSeasons`, `resume`. |
| Research prompt | `buildJudgePrompt(task)` (`scraperClaude.ts:249`) | Already instructs: search DCI.org, corps/staff listings, LinkedIn/band assocs, Wayback + image/video for headshots; cite sources; JSON-only out. |
| Image byte cache | `MediaService` (`sdk/src/mediaService.ts`) + `media-cache.db`; metadata in `media_assets` | For caching headshot bytes (chosen option). |

### Gaps to close
- **G1 — Ordering:** `finalizeJudgeTasks` (`scraperClaude.ts:881`) sorts tasks
  **alphabetically**, so `maxTasks` ≠ "top by assignments". Add
  assignment-count ranking + a `targetJudgeIds` option.
- **G2 — No entrypoint:** nothing in `sdk/scripts/` runs the pipeline. Add one.
- **G3 — Headless web access:** `runClaudeCommand` shells `claude -p <prompt>`
  (`scraperClaude.ts:918`) with no `--allowedTools`; web search may be disabled
  in that subprocess. Must verify / pass allowed tools, or bypass (see §4).

## 3. Top 12 judges by assignment count (the targets)

| Rank | judge_id | Name | Assigns | Seasons | Captions |
|---|---|---|---|---|---|
| 1 | `c-nelson-1` | Carl Nelson | 110 | 2013–2025 | 4 |
| 2 | `w-dillon-1` | Wayne Dillon | 109 | | |
| 3 | `j-howell-1` | John Howell | 106 | | |
| 4 | `m-turner-1` | Michael Turner | 106 | | |
| 5 | `r-solomon-1` | Robert Solomon | 105 | | |
| 6 | `k-miller-1` | Kyle Miller | 103 | | |
| 7 | `n-jones-1` | Nola Jones | 103 | | |
| 8 | `k-baker-1` | Keith Baker | 101 | | |
| 9 | `j-orefice-1` | Juno Orefice | 99 | | |
| 10 | `w-chumley-1` | William Chumley | 99 | | |
| 11 | `g-fugett-1` | Glenn Fugett | 97 | | |
| 12 | `c-moss-1` | Chris Moss | 94 | | |

(Per-judge season/caption context is pulled from `judge_assignments` +
`competitions` at runtime to seed the research prompt and disambiguate
same-named people.)

## 4. Approach (per the chosen options: Both · cache bytes · dry-run first)

### Phase A — Direct research by me (quality path, the 12)
For each of the 12, in assignment-rank order:
1. Pull DB context (seasons, captions, corps relations) to disambiguate and
   ground the search — many are band directors / music educators.
2. Research with my own **WebSearch / WebFetch** tools, following the existing
   `buildJudgePrompt` protocol: DCI.org bios & recaps → official corps/school/
   university staff pages → band-association & music-ed sources → LinkedIn /
   press → Wayback for dead links → image/video for a headshot.
3. For **every fact**: record a **source URL** + **confidence (HIGH/MEDIUM/LOW)**
   (HIGH = official site/verified; MEDIUM = reputable secondary; LOW = inferred).
   Don't guess; unverifiable ⇒ omit. (Mirrors the show-announcement confidence
   rules in `sdk/docs/2026-show-announcements-plan.md`.)
4. Assemble a `JudgeBioProfile`: `biography` (background, education, performing/
   teaching history, notable achievements), `photoUrl`, `alternateNames`,
   `externalLinks`, `corpsRelations` (with `sourceUrl`), `seasonHighlights`,
   and `media` (interviews/videos), tagged `ownerType="judge"`.

### Phase B — Image byte caching (chosen: URL + bytes)
For each resolved `photoUrl`, fetch + store bytes via `MediaService` into
`media-cache.db`, and record metadata in `media_assets` (owner = judge id), so
headshots survive the source going offline. Keep the original `photoUrl` in
`judges.photo_url`. Respect the existing SSRF host-allowlist on fetch-on-miss.

### Phase C — Dry-run → review → apply (chosen: dry-run first)
1. Write all 12 profiles to a **JSON report** (`sdk/results/judge-bios-*.json`)
   — full profile + per-fact sources/confidence + a diff vs current (NULL) DB.
   **No DB writes yet.**
2. You review the report.
3. Apply with `--apply`: call `upsertJudgeProfile` for each (coalescing — never
   nulls existing data) + commit the cached image bytes.

### Phase D — Make it repeatable (the pipeline, for the other 231)
1. **Fix G1:** rank `finalizeJudgeTasks` by assignment count; add
   `targetJudgeIds` + `topN` options to `runClaudeJudgeScraper`.
2. **Fix G2:** add `sdk/scripts/researchJudges.ts` — flags `--top <n>`,
   `--judge <id>`, `--apply` (default dry-run), `--concurrency`, `--seasons`.
   Writes the same JSON report; reuses the existing pipeline + writer.
3. **Fix G3:** make the runner pass `--allowed-tools WebSearch,WebFetch` (and
   verify the `claude -p` subprocess can actually browse); fall back to direct
   `fetch`/Browserbase per the tiered browser stack if not. Validate on 1 judge
   before a bulk run.
4. Leave the remaining 231 as an opt-in bulk run (not part of this task).

## 5. Data-safety & conventions
- **Dry-run/diff first**, coalescing upsert (scraped non-null wins, missing never
  nulls out), guardrails against placeholder garbage — consistent with the corps
  ingest convention in CLAUDE.md.
- `dci-relational.db` is ~2.5 GB and effectively un-backed-up: no schema changes
  needed here (tables already exist); writes are additive upserts only.
- Cite sources for every fact; prefer official/verified; flag MEDIUM/LOW for
  review rather than writing silently.

## 6. Deliverables
- `sdk/results/judge-bios-<timestamp>.json` — 12 reviewed profiles + sources.
- Populated `judges.biography/photo_url`, `judge_links`, `judge_corps_relations`,
  `judge_highlights`, `media_assets` for the 12 (after `--apply`).
- Cached headshot bytes in `media-cache.db`.
- `sdk/scripts/researchJudges.ts` + ranking/targeting fixes in `scraperClaude.ts`.

## 7. Open questions
1. Bio length/voice — short factual paragraph (~3–5 sentences) vs longer? (Default: concise, factual, sourced.)
2. For same-named/ambiguous judges with no findable online presence, leave NULL + note, or store a minimal DCI-derived stub? (Default: NULL + note.)
</content>
</invoke>
