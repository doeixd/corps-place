# Prediction Feature Code Review

Date: 2026-06-30

Scope: current-season event predictions, score ingest, as-of/snapshot behavior, future-only regeneration, feature construction, score/diff calculation, read-model publishing, and operational observability.

Local validation note: this worktree's `sdk/dci-relational.db` is a 0-byte placeholder, so I could not verify live row counts or run end-to-end DB queries against the source prediction tables. Findings below are source-level findings, with runtime validation called out where needed.

## Resolution status (updated 2026-06-30)

10 of 12 findings are fixed (each verified against the real code/DB and shipped as a focused commit). The two remaining are larger and deferred to their own work.

| Finding | Severity | Status |
|---|---|---|
| #1 New scores don't trigger future regeneration | High | ✅ Fixed — auto-ingest now backfills actuals → regenerates future-only → publishes once |
| #2 "Future only" includes same-day completed shows | High | ✅ Fixed — "future" defined by score state, not calendar date |
| #3 As-of history not exposed by read-model/pages | High | ⏳ Deferred — architectural; this is milestone M3 of `SEASON_INGEST_AND_PREDICTION_HISTORY_PLAN.md` (snapshot table/matrix + snapshot-aware read paths + slider) |
| #4 2026 scores-only pages render "coming soon" | High | ✅ Fixed — machine `ready` = has-prediction OR has-scores; route renders Scores when scores exist |
| #5 Runtime vs saved freshness-signature drift | Medium | ✅ Fixed — single shared `eventPredictionInputSignature` builder |
| #6 Scraper is AJAX-only, no HTML fallback | Medium | ✅ Fixed — server-rendered HTML fallback when AJAX config/POST unavailable |
| #7 Scraper refetches a reconstructed recap URL | Medium | ✅ Fixed — follows the list row's exact href; reconstruction is fallback only |
| #8 Diff aggregates compare partial denominators | Medium | ✅ Fixed — aggregates require all contributing subcaptions (test updated) |
| #9 Actual/error backfill updates only one run | Medium | ✅ Fixed — `listEventPredictionRuns` backfills every snapshot |
| #10 Pending detection ignores event_to_competition | Medium | ✅ Fixed — gate + notify resolve via bridge / season-prefix / bare slug |
| #11 Model selection inconsistent across workflows | Medium | ✅ Fixed — season workflow uses `findLatestV9SubcaptionModelDir` |
| #12 Operational observability too coarse | Low | ⏳ Deferred — additive structured per-run reports |

## Findings

### High: New scores do not trigger immediate future prediction regeneration

`scripts/auto-ingest-scores.sh` detects new score rows and immediately republishes the read-model, but it does not regenerate predictions for remaining future events or backfill prediction errors before publishing. The new scores become visible on score pages, but future predictions remain based on the previous model inputs until `scripts/nightly-predictions.sh` runs later.

Evidence:

- `scripts/auto-ingest-scores.sh:102-105` runs `refresh-prod-read-model.sh` after a score-count delta.
- There is no call from that script to `predictEventRecap.ts`, `nightly-predictions.sh`, or `updateEventPredictionStatus.ts`.
- `scripts/nightly-predictions.sh:24-65` is the script that regenerates missing/upcoming predictions and republishes, but it is decoupled from score release.

Impact: after a show releases scores, the site can show actual scores and stale future forecasts at the same time. This violates the expected "updated when new scores are released" behavior.

Recommendation: after ingesting a score delta, run a single pipeline that:

1. backfills actuals/errors for all saved runs for the completed event,
2. regenerates predictions only for future uncompleted events,
3. emits/publishes the read-model once.

### High: "Future only" regeneration includes same-day completed shows

`nightly-predictions.sh` claims finished events keep their run, but the SQL includes any event with `e.start_date >= date('now')`.

Evidence:

- Comment says "Already-finished events keep their run" at `scripts/nightly-predictions.sh:32-34`.
- Filter is `p.event_slug IS NULL OR e.start_date >= date('now')` at `scripts/nightly-predictions.sh:35-36`.

Impact: if the script runs after a show has completed but before UTC date rollover, it can regenerate that completed show's prediction after actual scores are known. That weakens as-of semantics and can overwrite the latest visible run for a completed event, because read paths use latest-per-event.

Recommendation: define "future" from score state or event end time, not calendar date. Exclude events with any ingested `corps_scores` via `event_to_competition` or the resolved competition slug. If end times are available, require scheduled end > now and no scores.

### High: As-of history is stored but not exposed by the read-model/page paths

The database schema can preserve prediction history, but the app/read-model mostly collapses it to the latest run per event.

Evidence:

- `model_event_prediction_runs` stores one run per `prediction_id`, but `sdk/src/readModel/builders/predictions.ts:98-105` orders by `predicted_at DESC LIMIT 1`.
- `sdk/scripts/emitReadModel.ts:1023-1045` emits one `rm_event_prediction` row per event.
- `rm_event_prediction` is keyed by `event_slug TEXT PRIMARY KEY` in `sdk/scripts/emitReadModel.ts:320-322`.
- Corps season points use `MAX(predicted_at) GROUP BY event_slug` in `sdk/src/readModel/builders/corps.ts:257-272`.
- VS predicted overlay also uses latest-per-event in `sdk/src/readModel/builders/vs.ts:170-188`.
- There is a live helper for as-of snapshots, `buildVsPredictionSnapshot`, at `sdk/src/readModel/builders/vs.ts:221-247`, but it is explicitly "never a frozen shard" and is not emitted into the production read-model.

Impact: "prediction as of date X" cannot be reconstructed from the served read-model. Past completed event forecasts can be visually replaced by newer same-day or later runs because the UI selects latest, not latest <= as-of.

Recommendation: add a prediction snapshot table/projection keyed by `(season, snapshot_at, event_slug)` or emit a per-corps matrix. Keep current latest summary for fast event pages, but add snapshot-aware read APIs for charts and history.

### High: 2026 scores-only pages can render "Prediction coming soon" instead of Scores

The current 2026 page initializes `view = 'scores'` when scored recap exists, but the status region only enters `ready` when `prediction != null`. If scores exist and prediction is missing, the page stays `idle` and renders the prediction-missing shell.

Evidence:

- Machine sets `view` to scores when `scoredRecap` exists at `app/machines/prediction-machine.ts:324-334`.
- Machine only auto-transitions from idle to ready when `context.prediction != null` at `app/machines/prediction-machine.ts:360-365`.
- Route renders the idle status card at `app/routes/events/$yearSlug/$slug/prediction.tsx:1098-1115`.
- Scores view is inside the `ready` branch and inside `<Show when={!!prediction}>` at `app/routes/events/$yearSlug/$slug/prediction.tsx:1143-1157`, then the scores table at `1196-1215`.

Impact: a 2026 event with scores but no saved prediction can hide real scores on the prediction route. This is likely for events unsupported by the model, failed prediction runs, or newly ingested scored events before nightly prediction generation.

Recommendation: make `ready` mean "has prediction or has scores", or split prediction status from page data availability. The scores branch should render independently of prediction existence.

### Medium: Runtime freshness signature drifts from the saved prediction signature

The script that saves a prediction and the app service that checks freshness do not hash the same input contract.

Evidence:

- Saved signature includes `same_season_breakdown_prior` at `sdk/scripts/predictEventRecap.ts:659-699`.
- App freshness signature omits that field at `app/lib/event-prediction-api.ts:436-458`.
- Saved signature hashes the lineup actually used by the script, including championship fallback lineups from `sdk/scripts/predictEventRecap.ts:1226-1240`.
- App freshness signature only reads `scored_event_lineup` and returns `undefined` if that view has no rows at `app/lib/event-prediction-api.ts:424-435`.
- `isCachedPredictionFresh` compares those two signatures directly at `app/lib/event-prediction-api.ts:477-489`.

Impact: manual/dev refreshes can treat otherwise identical cached predictions as stale, or fail to prove freshness for fallback-lineup events. In production this is mostly masked by the read-model fast path, but the code is brittle and hard to reason about.

Recommendation: share one signature builder between `predictEventRecap.ts` and `event-prediction-api.ts`, or persist the full normalized input audit as structured data and recompute from the same helper used by the predictor.

### Medium: The automatic score scraper is AJAX-only and has no HTML fallback

The project notes say score-list AJAX can be blocked and HTML fallback is important, but the production scraper path requires AJAX config and AJAX response success.

Evidence:

- `fetchScoreEventsConfig` throws if AJAX config is missing at `sdk/src/websiteScraper.ts:88-100`.
- `fetchScoreEventsPage` throws if the AJAX POST is not ok or JSON data is missing at `sdk/src/websiteScraper.ts:123-145`.
- `collectScoreListEntries` obtains config once and then scrapes pages with `(ajax)` at `sdk/src/websiteScraper.ts:395-410`.
- `parseScoresListHtml` can parse HTML, but this path only receives AJAX content from `scrapeScoresListPage`.

Impact: a Cloudflare/AJAX failure can make the auto-ingest job fail instead of parsing server-rendered score list HTML or using cached score-list pages. That is a release-time availability risk.

Recommendation: implement score-list collection as "AJAX if available, HTML fallback otherwise", and classify failure modes distinctly: no scores yet, parse shape changed, blocked fetch, and DB write failure.

### Medium: The scraper parses list hrefs but refetches a reconstructed recap URL

`parseScoresListHtml` extracts an absolute `entry.url`, but `scrapeWebsiteRecapByEntry` reconstructs `https://www.dci.org/scores/recap/${entry.id}` instead of following `entry.url`.

Evidence:

- Parsed entry carries `url` from the list href in `sdk/src/websiteRecap.ts:210-229`.
- Scraper rebuilds `recapPageUrl = recapUrl(entry.id)` and fetches by slug at `sdk/src/websiteScraper.ts:343-355`.

Impact: if DCI uses `/scores/final-scores/<slug>/`, a renamed path, or a URL shape that still parses to a slug but does not exist under `/scores/recap/`, the happy path can fail even though the list row had the correct link.

Recommendation: fetch `entry.url` exactly, store it as `sourceUrl`, and keep slug reconstruction only as a fallback/provenance field.

### Medium: Score-ingest pending detection ignores event-to-competition mapping

The auto-ingest gate checks whether a pending event already has scores with `corps_scores.competition_slug = events.slug`. Most 2026 competition slugs are season-prefixed or mapped through `event_to_competition`.

Evidence:

- Pending gate iterates `events.slug` at `scripts/auto-ingest-scores.sh:55-57`.
- It checks `SELECT COUNT(*) FROM corps_scores WHERE competition_slug=?` with that event slug at `scripts/auto-ingest-scores.sh:75-77`.

Impact: after scores are ingested under `2026-...` or another competition slug, the gate can still consider the event pending throughout the post-show window. The later global count delta prevents republishing if no rows are added, but the script will keep scraping and logging avoidable work.

Recommendation: resolve the event's competition slug the same way the app/read-model does, or check `event_to_competition` plus both raw and season-prefixed slug candidates.

### Medium: Actual/error backfill updates only one run

`updateEventPredictionStatus.ts` defaults to the latest prediction run for the event and then calls `updateEventPredictionErrors` for that run only.

Evidence:

- Latest run selection is `latestEventPredictionRun(db, eventSlug, cli.predictionId)` at `sdk/scripts/updateEventPredictionStatus.ts:222-226`.
- `latestEventPredictionRun` selects `ORDER BY predicted_at DESC LIMIT 1` when no prediction id is supplied at `sdk/src/training/v9EventPredictionDb.ts:223-233`.
- Error update writes rows for one `prediction_id` at `sdk/src/training/v9EventPredictionDb.ts:245-302`.

Impact: historical runs for the same event do not get actuals/errors filled automatically. This undercuts prediction-history analysis and any future as-of slider that wants to show how each snapshot performed.

Recommendation: add an "update all runs for event/competition" path and call it from post-score ingest. Keep single-run update for targeted debugging.

### Medium: Diff aggregate calculation can compare partial aggregates

`computeDiff` derives GE/Visual/Music/Total from whatever subcaptions are present on each side. It returns an aggregate if any contributing subcaption exists, not if all required subcaptions exist.

Evidence:

- `aggregateSide` uses `present(...cs) => cs.some(...)` at `app/lib/diff.ts:51-68`.
- The test explicitly expects a partial GE aggregate where scored has only GE1 and predicted has GE1+GE2 at `app/lib/diff.test.ts:64-76`.

Impact: if a recap has partial caption data, aggregate diffs can look precise while comparing different denominators. Example: scored GE1 only vs predicted GE1+GE2 yields a large aggregate mismatch that is really missing data.

Recommendation: require all contributing subcaptions for an aggregate, or use source aggregate columns when available and mark the basis in the tooltip. Partial aggregates should be displayed as unavailable or "partial".

### Medium: Model selection is inconsistent across workflows

The canonical latest-model helper avoids experimental builds by tiering production/final names, but `seasonUpdateWorkflow.ts` has its own mtime-based latest selector.

Evidence:

- Production helper is `findLatestV9SubcaptionModelDir` in `sdk/src/training/v9ModelPaths.ts`.
- `seasonUpdateWorkflow.ts:302-310` independently picks the newest `model.json` by mtime.

Impact: fine-tune/update workflows can select a copied, smoke, or experimental model if its mtime is newest, even though event prediction uses the safer helper. This is a reproducibility risk.

Recommendation: delete the local helper and import `findLatestV9SubcaptionModelDir`.

### Low: Operational observability is too coarse for score release automation

The scripts log useful text, but they do not produce a structured per-event outcome that can be audited or alerted on.

Evidence:

- `auto-ingest-scores.sh` gates, tails the last few scraper lines, compares global `corps_scores` count, and publishes on any delta at `scripts/auto-ingest-scores.sh:90-118`.
- `nightly-predictions.sh` continues after individual failures and still republishes the read-model at `scripts/nightly-predictions.sh:51-65`.
- There is no persistent job table or JSON report for "score row found, recap fetched, ingest count, predictions regenerated, actuals matched, read-model emitted".

Impact: failures can be hard to distinguish: no scores yet, DCI blocked, parser drift, DB no-op, prediction generation failure, and publish failure all require log spelunking.

Recommendation: write a `results/score-ingest-runs/*.json` report or DB job table per run, and include event slug, resolved competition slug, list entry URL, ingest counts, prediction runs touched, future runs regenerated, read-model generation, and notification counts.

## Things That Look Correct

- The V9 feature builder uses `competition_date < targetDate` for template rows and same-season history, which is the right as-of cutoff shape for prior-score features (`sdk/src/training/v9PredictionFeatures.ts:69-90`, `sdk/scripts/predictEventRecap.ts:761-768`).
- Prediction point totals are recomputed from the eight displayed caption point estimates using DCI weights: `GE1 + GE2`, `(VP + VA + CG) / 2`, `(MB + MA + MP) / 2`, then total (`sdk/scripts/predictEventRecap.ts:1439-1466`). That keeps displayed caption totals and ranking internally consistent.
- Prediction storage is additive and idempotent by `prediction_id = event_slug:generated_at`; it can preserve history if read paths stop collapsing it (`sdk/src/training/v9EventPredictionDb.ts:57-96`, `118-184`).
- Production serving correctly avoids ML generation on the request path when `READ_MODEL_DB_URL` exists, using `rm_event_prediction` instead (`app/lib/event-prediction-api.ts:590-599`, `663-672`).

## Test Gaps To Add

- Auto-ingest integration test: a mocked score list grows, scraper follows the row URL, ingests rows, updates all matching prediction runs with actuals, regenerates future-only predictions, and emits once.
- Future-only test: same-day completed event with scores must not regenerate; future event must regenerate after a score release.
- Read-model snapshot test: two prediction snapshots produce a matrix where as-of T1 and latest select different future predictions but preserve completed event actuals.
- Scores-only route test: 2026 route with `recap` and no `prediction` renders Scores, not "Prediction coming soon".
- Freshness-signature parity test: script-saved signature and app-computed signature match for normal lineup, championship fallback lineup, and breakdown-prior enabled/disabled cases.
- Scraper fallback test: AJAX config missing or AJAX POST blocked still parses server-rendered scores-list HTML and follows the exact `href`.
