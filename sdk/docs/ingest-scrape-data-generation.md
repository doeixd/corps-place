# Ingest, Scrape, and Data-Generation Guide

This guide covers the ingestion, scraping, and data-generation scripts in the repo, why they exist, and how to run them.

For the production event prediction, score-checking, fine-tuning, and saved-prediction workflow, see `docs/production-event-prediction-runbook.md`.

## Conventions

- Most scripts are executed from `sdk/` with `npx tsx <script>`.
- Two SQLite files are in use: `sdk/dci-relational.db` (website scrape cache + recap ingestion) and `sdk/dci-relational.old.db` (backup of the previous relational db).

## Ingest and Scrape Scripts

- `sdk/src/scrapeWebsiteRecaps.ts` — Purpose: ingest cached API responses first, then scrape DCI website recaps and ingest into relational tables. Usage: `npx tsx src/scrapeWebsiteRecaps.ts --db file:./dci-relational.db --season 2024` or `--seasons 2013,2014,2015`. Options: `--db`, `--season`/`--seasons`, `--maxPages`, `--concurrency`, `--skipApiCache`. Notes: writes failures to `website_scrape_failures` and skips recaps with no valid totals.
- `sdk/src/reingestFromCache.ts` — Purpose: run API ingest first, then re-parse cached `website_recaps.raw_html` and re-ingest without re-scraping. Usage: `npx tsx src/reingestFromCache.ts --db file:./dci-relational.db --season 2013` or `--seasons 2013,2014`. Options: `--db`, `--season`/`--seasons`, `--skip-api`, `--persist-rankings` (opt-in).
- `sdk/scripts/ingestAllSeasons.ts` — Purpose: full relational ingest via DCI API for the hardcoded season list (2013–2026), then scrape website recaps and event pages and ingest lineups for performance order. Usage: `npx tsx scripts/ingestAllSeasons.ts`. Notes: hardcoded to `file:./dci-relational.db`, uses warm cache, `seasonConcurrency=1`, `competitionConcurrency=2`, `scoreConcurrency=4`, rankings are persisted by default (use `--skip-rankings` to disable).
- `sdk/scripts/ingestAllData.ts` — Purpose: end-to-end ingest (API + website recaps + Wayback). Usage: `npx tsx scripts/ingestAllData.ts --seasons 2013,2014,...` with optional `--no-cache-first` (disable default cache-first pass), `--cache-only` (cache-only pass, skips live API/website fetch), `--no-wayback-prime` (disable default CDX priming of event Wayback availability cache), `--skip-wayback`, `--wayback-all`, `--wayback-events <file>`, `--wayback-corps <file>`, `--fetch-current-year`.
- `sdk/scripts/seasonUpdateWorkflow.ts` — Purpose: in-season update workflow for one season, intended for 2026 rolling updates. It ingests API competitions/events, reports schedule/times, scrapes event pages for lineup/performance order, scrapes released recaps when judge/caption detail is missing, rebuilds V9 ML artifacts with an explicit `--as-of-date`, and can optionally fine-tune the V9 subcaption model from an existing model directory. **Important:** The DCI API (`api.dci.org`) was decommissioned in May 2026. For 2026+, you **must** use `--skip-api` or the workflow will fail with `DciNetworkError`. Bootstrap events first with `ingestEventsFromWebsite.ts`, then run this workflow. Usage: `npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-07-05 --skip-api`; dry run: `npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-07-05 --dry-run --skip-api`; fine tune: `npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-07-05 --fine-tune --model-dir models/v9_subcaption_fixed/<run> --skip-api`. Useful options: `--force`, `--allow-future-data`, `--skip-api`, `--skip-event-pages`, `--skip-recaps`, `--skip-ml`, `--epochs`, `--patience`, `--samples-per-epoch`, `--batch`, `--lookahead-days`, `--refresh-past-days`.
- `sdk/scripts/predictEventRecap.ts` — Purpose: user-friendly event readiness and V9 recap prediction workflow for a future or upcoming event. It checks whether schedule, lineup/performance order, competition metadata, and judge assignments exist, can run the schedule/event-page refresh workflow, and writes a prediction JSON/table for the event. Usage: `npm run event:check -- --event "Drums Along the Rockies" --season 2026`; with refresh: `npm run event:check -- --event "Drums Along the Rockies" --season 2026 --refresh`; predict and save: `npm run event:predict -- --event "Drums Along the Rockies" --season 2026 --model-dir models/v9_subcaption_fixed/<run> --save-db`. Useful options: `--event`, `--season`, `--model-dir latest|<dir>`, `--division "World Class"|auto`, `--mode auto|as_of_show_date|preseason_forecast|panel_unknown|lineup_unknown`, `--percent-through`, `--refresh`, `--force-refresh`, `--check-only`, `--save-db`, `--output`. Notes: if judges are missing it uses panel-unknown behavior; if same-season history is missing it uses preseason forecast behavior; if the event has participants but no explicit lineup, participants are used with unknown performance-order context; if a lineup corps has no historical template row it uses synthetic unknown-corps features.
- `sdk/scripts/updateEventPredictionStatus.ts` — Purpose: post-show prediction operations. It checks whether actual scores/recaps are available for an event, compares saved DB predictions to actual totals/captions, can run the season update workflow to refresh released scores, can fine-tune the V9 model, and can regenerate/save a new prediction. Usage: save a prediction first with `npm run event:predict -- --event "Drums Along the Rockies" --season 2026 --model-dir models/v9_subcaption_fixed/<run> --save-db`; later check scores/errors with `npm run event:scores -- --event "Drums Along the Rockies" --season 2026 --refresh`; fine-tune and update with `npm run event:update -- --event "Drums Along the Rockies" --season 2026 --refresh --fine-tune --update-prediction --model-dir models/v9_subcaption_fixed/<run>`. Useful options: `--event`, `--season`, `--prediction-id`, `--model-dir latest|<dir>`, `--refresh`, `--fine-tune`, `--update-prediction`, `--allow-future-data`, `--check-only`. Notes: saved predictions live in `model_event_prediction_runs` and `model_event_prediction_rows`; errors are backfilled into the row table when actual scores are available; `--refresh` skips the ML rebuild unless `--fine-tune` is also requested; after fine-tuning, `--update-prediction` uses the newest V9 candidate model.
- `sdk/scripts/reingest2024.ts` — Purpose: re-ingest 2024 season via API (no warm cache). Usage: `npx tsx scripts/reingest2024.ts`. Notes: hardcoded to `file:./dci-relational.db`.
- `sdk/scripts/ingestWaybackCorpsContacts.ts` — Purpose: import historical corps contact data from Wayback JSON. Usage: `npx tsx scripts/ingestWaybackCorpsContacts.ts [path/to/wayback_corps.json]`. Default input: `wayback/wayback_dci_corps_contacts_complete.json`.
- `sdk/scripts/ingestWaybackEvents.ts` — Purpose: import historical event data from Wayback JSON. Usage: `npx tsx scripts/ingestWaybackEvents.ts [path/to/file.json]` or `--all` or `--fetch-current-year`. Notes: hardcoded to `file:./dci-relational.db`.
- `sdk/scripts/ingestEventsFromWebsite.ts` — Purpose: bootstrap the `events` table from the live DCI website schedule via the `admin-ajax.php?action=load_events` endpoint. This is required for 2026+ now that `api.dci.org` is decommissioned. Usage: `npx tsx scripts/ingestEventsFromWebsite.ts --season=2026`. Notes: parses HTML event cards with `cheerio`, creates synthetic `event_id`s (`web-<season>-<slug>`), and upserts into the `events` table.

- `sdk/scripts/ingestLineupsFromScrapes.ts` — Purpose: re-process `event_page_scrapes` lineup JSON into `event_lineup_entries` and `event_participants`. Usage: `npx tsx scripts/ingestLineupsFromScrapes.ts`.
- `sdk/scripts/backfillLineupClassification.ts` — Purpose: audit and optionally repair derived lineup rows whose labels match canonical `domain_event_exclusion_patterns` categories `schedule_item` / `not_a_corps` (for example `Event Concludes` linked as a corps). Dry-run usage: `npx tsx scripts/backfillLineupClassification.ts`; apply after reviewing the report: `npx tsx scripts/backfillLineupClassification.ts --apply`. Notes: marks matched rows non-performance, unlinks schedule/noise participants, and deletes bogus corps only when they have no score or prediction evidence.
- `sdk/scripts/backfillEventVenues.ts` — Purpose: backfill `event_venues` from `events` and latest `event_page_scrapes` location fields when source payloads lack nested `event.venue`. Usage: `npx tsx scripts/backfillEventVenues.ts`.
- `sdk/scripts/scrapeEventPages.ts` — Purpose: scrape event pages for lineup/performance order source data. Usage: `npx tsx scripts/scrapeEventPages.ts --season=2024` with optional `--overwrite`, `--refresh-wayback-cache`, `--refresh-wayback-missing`. Notes: by default skips slugs already present in `event_page_scrapes`; caches Wayback availability in `event_wayback_availability`.
- `sdk/scripts/primeWaybackEventAvailability.ts` — Purpose: preload `event_wayback_availability` from Wayback CDX (`/events/*`) so event-page scraping avoids repeated availability lookups. Usage: `npx tsx scripts/primeWaybackEventAvailability.ts --seasons 2013,2014`.
- `sdk/scripts/primeWaybackApiAvailability.ts` — Purpose: preload `api_wayback_availability` from Wayback CDX (`api.dci.org/api/v1/events*`) so API Wayback fetches can reuse known snapshots. Usage: `npx tsx scripts/primeWaybackApiAvailability.ts --seasons 2013,2014`.
- `sdk/scripts/fetchRawRecap.ts` — Purpose: fetch and save a single raw recap JSON from the API. Usage: edit the `slug` constant, then run `node scripts/fetchRawRecap.ts`.
- `sdk/src/scraper.ts` — Purpose: library orchestrator for API scraping with optional website recap scraping. Used by `ingestRelationalData`. Key options: `includeRecaps`, `includeEvents`, `includeGlobal`, `includeGalleries`, `includeWebsiteRecaps`, `websiteRecapOptions`, `warmInstructions`, `concurrency`, `seasons`.

## Data-Generation and ML Prep Scripts

### Sequence builders

- `sdk/scripts/buildMlSequencesV7All.ts` — Purpose: build V7 ML sequences table `ml_sequence_rows_v7`. Usage: `npx tsx scripts/buildMlSequencesV7All.ts`.
- `sdk/scripts/runBuildSequencesV7.ts` — Purpose: build V7 sequences and print summary stats. Usage: `npx tsx scripts/runBuildSequencesV7.ts`.
- `sdk/scripts/buildMlSequencesV9All.ts` — Purpose: build V9 ML sequences table `ml_sequence_rows_v9_subcaption`. Usage: `npx tsx scripts/buildMlSequencesV9All.ts`; cutoff-safe in-season rebuild: `npx tsx scripts/buildMlSequencesV9All.ts --as-of-date 2026-07-05 --rebuild`.
- `sdk/scripts/buildMlSequencesV9SubcaptionMTL.ts` — Purpose: build V9 subcaption multi-task table `ml_sequence_rows_v9subcaption_mtl`. Usage: `npx tsx scripts/buildMlSequencesV9SubcaptionMTL.ts`.
- `sdk/src/buildMlSequencesV6Production.ts`, `sdk/src/buildMlSequencesV6FinalsBlind.ts`, `sdk/src/buildMlSequencesV7.ts`, `sdk/src/buildMlSequencesV9.ts`, `sdk/src/buildMlSequencesV9Subcaption.ts` — Purpose: core builders used by the scripts above. Usage: imported by wrapper scripts; run directly only if you wire your own entrypoint.

### Legacy V5 exports

- `sdk/scripts/exportXgboostFeaturesV5.ts` — Purpose: export V5 sequence features to CSV for XGBoost training. Usage: `npx tsx scripts/exportXgboostFeaturesV5.ts --db ./dci-relational.db --out ./xgboost-features-v5.csv` with optional `--split train|val|test`.
- `sdk/scripts/exportBaselineErrorsV5.ts` — Purpose: compute baseline residual errors for V5 sequences. Usage: `npx tsx scripts/exportBaselineErrorsV5.ts --db ./dci-relational.db --split val --baseline baseline_ema --out ./baseline-errors.json`. Options: `--baseline baseline_zero|baseline_last|baseline_ema|baseline_lr`.
- `sdk/scripts/formatBayesianPredsV5.ts` — Purpose: normalize Bayesian outputs into `{ corps_key, predicted }`. Usage: `npx tsx scripts/formatBayesianPredsV5.ts --input ./raw.json --out ./bayesian-preds.json`.
- `sdk/scripts/buildBayesianErrorsV5.ts` — Purpose: compare Bayesian predictions to recap data and write error JSON. Usage: `npx tsx scripts/buildBayesianErrorsV5.ts --competition <slug> --season <year> --predictions ./bayesian-preds.json` with optional `--division`, `--db`, `--out`.

### Feature and reference builders

- `sdk/scripts/buildHistoricalFeaturesV5.ts` — Purpose: build `corps_historical_features_v5`. Usage: `npx tsx scripts/buildHistoricalFeaturesV5.ts`.
- `sdk/scripts/buildHistoricalFeaturesV6.ts` — Purpose: build `corps_historical_features_v6`. Usage: `npx tsx scripts/buildHistoricalFeaturesV6.ts`.
- `sdk/scripts/buildShowAggregatesV7.ts` — Purpose: build `show_aggregates_v7`. Usage: `npx tsx scripts/buildShowAggregatesV7.ts`.
- `sdk/scripts/computeEloRatingsV7.ts` — Purpose: build `judge_elo_*` and `corps_elo_*` tables. Usage: `npx tsx scripts/computeEloRatingsV7.ts`.
- `sdk/scripts/computeReferenceCurves.ts` — Purpose: write `src/training/referenceCurvesPercent.json`. Usage: `npx tsx scripts/computeReferenceCurves.ts`.
- `sdk/scripts/computeReferenceCurvesV4.ts` — Purpose: write `src/training/referenceCurvesV4.json`. Usage: `npx tsx scripts/computeReferenceCurvesV4.ts`.

### Index map generators

- `sdk/scripts/buildCorpsIndexMap.ts` — Purpose: write `src/training/corpsIndexMap.json`. Usage: `npx tsx scripts/buildCorpsIndexMap.ts`.
- `sdk/scripts/buildJudgeIndexMap.ts` — Purpose: write `src/training/judgeIndexMap.json`. Usage: `npx tsx scripts/buildJudgeIndexMap.ts`.
- `sdk/scripts/generateShowMap.ts` — Purpose: write `src/training/showIndexMap.json`. Usage: `npx tsx scripts/generateShowMap.ts`.

### Pipeline helpers

- `sdk/scripts/refreshV7.ts` — Purpose: end-to-end V7 refresh (reingest 2024, Elo, aggregates, sequences, optional fine-tune). Usage: `npx tsx scripts/refreshV7.ts` or `npx tsx scripts/refreshV7.ts --fine-tune --model-dir models/v7_curriculum/best`.
- `sdk/scripts/ensureV7Schema.ts` — Purpose: ensure V7 schema extensions exist. Usage: `npx tsx scripts/ensureV7Schema.ts`.
- `sdk/scripts/applySchemaV7.ts` — Purpose: apply V7 schema extensions and print the table list. Usage: `npx tsx scripts/applySchemaV7.ts`.
- `sdk/scripts/recreateV7Table.ts` — Purpose: drop and recreate `ml_sequence_rows_v7` with updated schema. Usage: `npx tsx scripts/recreateV7Table.ts`.
- `sdk/scripts/prepareColab.ts` — Purpose: package the SDK + db into `sdk-colab.zip` for Colab usage. Usage: `npx tsx scripts/prepareColab.ts`.

## Notes and Gotchas

- **api.dci.org is decommissioned (May 2026).** The public DCI API no longer resolves in DNS. Any script that makes live API calls (e.g., `ingestRelationalData`, `makeDciApiLayer`) will fail with `DciNetworkError`. Use `--skip-api` in workflows, bootstrap events with `ingestEventsFromWebsite.ts`, and rely on website scraping and historical cache for data.
- Many scripts hardcode `file:./dci-relational.db`; update those constants if you want a different file.
- Website scraping is network sensitive; failures are recorded in `website_scrape_failures` for later retry.
- Event page slug matching is mixed (`slug` vs `season-slug`); `scrapeEventPages.ts` now tries both URL forms and logs as `season:slug` when season is known.
- If you change caption normalization or judge initials logic, re-run `src/reingestFromCache.ts` for website recaps and/or API ingestion scripts for API-derived recaps.
