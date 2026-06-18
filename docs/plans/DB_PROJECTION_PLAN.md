# Plan: DB projections (purpose-built copies of the relational DB)

Status: **proposed / handoff** — written for a fresh agent. Read **AGENTS.md** (Effect +
conventions) and **DEPLOY-legacy-exe.dev.md** first. The source DB is `sdk/dci-relational.db`.

## Why

The 2.4 GB `dci-relational.db` is three databases wearing one trenchcoat: an **archival
raw-scrape store**, the **application/serving DB**, and the **inference/training feature
store**. They have wildly different read patterns, sizes, and lifecycles. We want an
Effect module that projects the source into **purpose-built, optimized copies** so each
consumer carries only what it needs.

### Measured size breakdown (via `dbstat` — this drives everything)

| Table                                                                                                                                              | Size          | Purpose                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------ |
| `website_recaps` (raw_html, parsed_json)                                                                                                           | **1629 MB**   | **archive** (re-parse source)              |
| `website_score_lists` (raw_html, parsed_json)                                                                                                      | 294 MB        | archive                                    |
| `ml_sequence_rows_v9_subcaption` / `_v9` / `_v9subcaption_mtl`                                                                                     | 119+112+83 MB | **train** (feature tensors)                |
| `api_responses` (response_json)                                                                                                                    | 38 MB         | archive (AJAX cache)                       |
| `season_ranking_entries`                                                                                                                           | 18 MB         | serve/derived                              |
| `subcaption_scores`                                                                                                                                | 18 MB         | infer/train (features)                     |
| `corps_page_scrapes` / `event_page_scrapes`                                                                                                        | 10 + 8 MB     | archive                                    |
| `corps_elo_history` / `judge_elo_history`                                                                                                          | 9 + 8 MB      | train (history)                            |
| `judge_scores` / `caption_scores` / `category_scores`                                                                                              | 8 + 7 + 3 MB  | infer/train (features)                     |
| `model_event_prediction_runs` / `_rows`                                                                                                            | 3.4 + 0.6 MB  | **serve** (the predictions the site shows) |
| `events` / `corps_scores` / `event_lineup_entries` / `event_participants` / `event_schedules` / `competitions` / `corps` / `judge_assignments` / … | ≤2 MB each    | **serve**                                  |

**Takeaways:**

- **~83% of the file (~2 GB) is archival raw HTML/JSON** that serving and inference never read.
- **~315 MB is ML training sequences** — needed for `--fine-tune`, not for serving and
  (likely) not for inference.
- **The entire serving surface is tens of MB.** A `serve.db` could be **~1–2% of today's file.**

## The three purposes → table classification

> ⚠️ **Finalize these lists by evidence, not guesswork (step P0 below).** The classification
> here is the starting hypothesis from table names + this session's knowledge of the app.

- **`serve`** (web reads only): `corps`, `corps_aliases`, `corps_class_history`, `events`,
  `event_lineup_entries`, `event_participants`, `event_schedules`, `event_venues`,
  `event_group_types`, `competitions`, `model_event_prediction_runs`,
  `model_event_prediction_rows`, `corps_scores` (+ `caption_scores`/`category_scores`/
  `subcaption_scores`/`judge_scores` **iff** the site renders actual recaps), `galleries`,
  `gallery_images`, `gallery_corps`/`tags`, `past_champions`, `season_rankings`,
  `season_ranking_entries`, `sponsors`, `page_content`, `judges`/`judge_*` (iff judge pages
  exist), `domain_*` lookups. **Excludes** all raw scrape tables, `api_responses`,
  `ml_sequence_*`, `*_elo_history`, wayback, `event_directory_refresh_runs`, scraper bookkeeping.
- **`infer`** (generate predictions): the feature-source tables `predictEventRecap.ts`
  reads — `corps`, `events`, `competitions`, `corps_scores`, `caption_scores`,
  `subcaption_scores`, `category_scores`, `judge_scores`, `judge_assignments`,
  `corps_elo_ratings` (+ history if used), `judge_elo_ratings`, reference-curve
  views/tables, `show_aggregates_v7`, `corps_historical_features_v*`, `corps_season_state_v5`,
  `event_lineup_entries`/`event_participants`/`event_schedules`, the `ml_*_vocab` tables,
  `domain_*`. **Excludes** raw scrape archive. **Likely excludes `ml_sequence_rows_*`**
  (those are _training_ sequences; inference builds features on the fly) — **verify**.
- **`train`** = `infer` ∪ `ml_sequence_rows_*` ∪ elo history. In practice this is "the working
  DB minus the raw-HTML archive" (~400 MB).
- **`archive`** (cold/audit/re-parse): `website_recaps`, `website_score_lists`,
  `api_responses`, `corps_page_scrapes`, `event_page_scrapes`, `*_wayback_availability`,
  `website_scrape_failures`, `scraper_progress`. ~2 GB; rarely read; re-parse source.

Sketch sizes after projection: **serve ≈ 30–60 MB**, **infer ≈ 150–250 MB**,
**train/working ≈ 400 MB**, **archive ≈ 2 GB**.

## Module design (Effect)

`sdk/src/dbProjection.ts` — `DbProjectionService` (Effect.Service, `accessors: true`,
`Effect.fn("…")` methods, `Schema.TaggedError` for failures, **no `runPromise` in the body**).
Uses `@libsql/client` for the raw DDL/ATTACH work (wrapped in `Effect.tryPromise`).

### Manifest (declarative, one entry per variant)

```ts
interface VariantManifest {
  readonly name: string; // 'serve' | 'infer' | 'train' | 'archive'
  readonly tables: ReadonlySet<string> | ((all: string[]) => string[]); // allow-list (preferred for serve)
  readonly exclude?: ReadonlySet<string>; // for "everything minus X" variants (train)
  readonly views?: readonly string[]; // views to recreate (e.g. reference-curve views) — after their tables
  readonly rowFilters?: Record<string, string>; // optional WHERE per table (default: full copy)
  readonly extraIndexes?: readonly string[]; // serve-only indexes if the slim DB wants different ones
}
```

Prefer an **allow-list** for `serve`/`infer` (new tables default _out_ — safe) and an
**exclude-list** for `train`/`archive` (everything minus the other half).

### Build algorithm (schema-preserving copy via ATTACH)

For one variant → `target.db`:

1. Build from a **consistent snapshot**: first `VACUUM INTO 'snapshot.db'` from the source
   (atomic, consistent even if a writer is active), then project from the snapshot. (Or
   sequence strictly after the nightly workflow when nothing writes.)
2. Open a fresh `target.db.tmp`; `PRAGMA foreign_keys=OFF`; `ATTACH 'snapshot.db' AS src`.
3. For each included table, in dependency order:
   - copy its `CREATE TABLE` DDL from `src.sqlite_master` (preserves PK/types/constraints;
     FKs to excluded tables are harmless with FKs off);
   - `INSERT INTO main."t" SELECT * FROM src."t" [WHERE rowFilters[t]]`;
   - recreate that table's indexes (`src.sqlite_master WHERE type='index' AND tbl_name=t AND sql IS NOT NULL`).
4. Recreate any required **views** (after their underlying tables exist) — the inference
   path uses reference-curve views; include them in `infer`/`train`.
5. `ANALYZE;` (planner stats — important for the slim DB) and `PRAGMA optimize`. The target
   is already compact (freshly written), so an explicit `VACUUM` is optional.
6. Close; **atomic `rename` `target.db.tmp` → `target.db`**.

### Why atomic rename is safe for the live web

The app's `withDb` (`corps-directory.ts` / `event-directory.ts`) opens a **fresh libsql
client per call** and closes it — there's no long-lived handle. So renaming a new
`serve.db` into place means the **next request opens the new inode** automatically; an
in-flight request finishes against the old file. No web restart needed. (Confirm `withDb`
still opens-per-call before relying on this.)

## Consumption (deploy wiring)

- **Web service:** `DCI_RELATIONAL_DB_URL=file:/srv/corps-place/sdk/serve.db` → reads the
  ~50 MB projection. Faster cold start, trivial backup, fits any host.
- **Nightly train/predict:** runs against the **working/`train`** DB (reads features, writes
  `model_event_prediction_*`). After it finishes → rebuild `serve.db` (and `infer.db` if a
  separate inference box exists) → atomic-swap.
- **`archive.db`:** cold store / re-parse source; pushed off-box (R2) as the durable copy.
- This also enables a future split (separate inference VM gets `infer.db`; web VM gets
  `serve.db`) — but in the monolith, one working DB + a projected `serve.db` is the win.

## Phase 2 — prune the working DB (optional, destructive, gated)

The biggest disk/IO win for the _nightly box_ is to stop carrying 2 GB of raw HTML in the
working DB: **extract archive tables → `archive.db`, then `DELETE`/`DROP` them from the
working DB and `VACUUM`** → working DB drops from 2.4 GB to ~400 MB. Because the archive is
the re-parse source, this must be **archive-first + verified** (build & checksum `archive.db`
before deleting), and ideally keep "latest scrape per page" in the working DB if any code
re-parses recent scrapes. Gate behind an explicit `--prune` flag and a dry-run. (Note:
`website_recaps` at 1.6 GB is the single biggest lever — pruning to latest-per-recap, or
moving it wholesale to `archive.db`, reclaims ~1.5 GB.)

## CLI / cadence

- `sdk/scripts/buildDbVariants.ts --variant serve|infer|train|archive|all [--out-dir .] [--snapshot] [--dry-run]`.
- Run **after** `seasonUpdateWorkflow` in the nightly job (source is fresh → project →
  swap `serve.db`). Also expose as an admin-dashboard trigger (see PREGEN_AND_ADMIN_PLAN.md).

## Acceptance criteria

- `serve.db` contains only the serving allow-list, has the right indexes (e.g. `corps(slug)`,
  `events(slug)`, the prediction/event indexes), `ANALYZE`d, and is **<5%** of the source size.
- The web, pointed at `serve.db`, renders every page identically to running on the full DB
  (corps directory/profile, events, prediction, appearances) — i.e. the allow-list is complete.
- `infer.db` is sufficient to run `predictEventRecap.ts --event <slug> --save-db` and produce
  the same prediction as on the full DB (this validates the infer manifest, incl. views).
- Rebuild is **idempotent and atomic** (build to `.tmp` → rename); a rebuild while the web
  serves causes no errors and the next request sees fresh data.
- Builds from a consistent snapshot (no corruption if a writer overlaps).

## Risks / open questions (resolve in P0)

- **Finalize the manifests from real query usage**, not names:
  - `serve`: grep `app/lib/*.ts` (`corps-directory`, `event-directory`, `event-prediction-api`,
    server fns, Fate sources) for every table/view referenced → that's the exact allow-list.
    Decide whether the site renders **actual recap scores** (→ include caption/subcaption/
    category/judge scores) or only predictions (→ exclude them).
  - `infer`: grep `sdk/scripts/predictEventRecap.ts` (+ its imports in `sdk/src`) for every
    table/**view** it reads → confirm whether `ml_sequence_rows_*` are needed (probably not).
- **Views:** SQLite views must be recreated after their base tables; inference relies on
  reference-curve views — include them and their dependencies, or the projection breaks.
- **FKs:** build with `foreign_keys=OFF`; the projections will have dangling FK definitions
  to excluded tables (harmless unless enforcement is turned on at runtime — the app doesn't).
- **Generated/derived tables:** some tables are rebuilt by ML scripts (`recreateViews`,
  `buildMlSequencesV9All`). Project _after_ those run so they're current.
- **Disk during build:** `VACUUM INTO` snapshot needs ~2.4 GB free transiently; fine on the
  100 GB box.

## Suggested order

1. **P0 — discovery:** derive the exact `serve` and `infer` table/view sets by grepping the
   consumers (above). Write them into the manifest.
2. `DbProjectionService` + `buildDbVariants.ts` (serve + infer first; train/archive next).
3. Wire `serve.db` into the web env + rebuild step into the nightly job; verify acceptance.
4. (Later) Phase 2 pruning behind `--prune`, archive-first.
