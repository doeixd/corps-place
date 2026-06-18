# Production Event Prediction Runbook

Updated: 2026-05-26

This document captures the operational details for predicting a future DCI event, checking the released scores afterward, fine-tuning the model, and preserving predictions/errors in SQLite.

## What This Solves

The production flow has two separate jobs:

1. Before a show: check whether schedule/lineup/judges exist and generate a V9 recap prediction.
2. After a show: refresh released scores/recaps, compare saved predictions to actual scores, optionally fine-tune, and optionally regenerate predictions from the updated model.

The user-facing commands are npm aliases in `sdk/package.json`:

```powershell
npm run event:check
npm run event:predict
npm run event:scores
npm run event:update
```

Internally these call:

- `scripts/predictEventRecap.ts`
- `scripts/updateEventPredictionStatus.ts`
- shared helpers in `src/training/v9EventPredictionDb.ts`
- shared latest-model lookup in `src/training/v9ModelPaths.ts`

## Typical Workflow

Run commands from `sdk/`.

### 1. Before The Event: Check Readiness

```powershell
npm run event:check -- --event "Drums Along the Rockies" --season 2026 --refresh
```

This prints:

- event slug/name/date/time/location
- matched competition slug, if present
- lineup row count and matched corps keys
- judge assignment count
- selected prediction mode
- estimated season percent-through

Use `--force-refresh` if the event page was already cached but you want to scrape it again.

### 2. Before The Event: Predict And Save

```powershell
npm run event:predict -- --event "Drums Along the Rockies" --season 2026 --model-dir latest --save-db
```

This writes:

- JSON prediction output under `results/predictions/`
- DB run row in `model_event_prediction_runs`
- DB prediction rows in `model_event_prediction_rows`

Use an explicit model for reproducibility:

```powershell
npm run event:predict -- --event "Drums Along the Rockies" --season 2026 --model-dir models/v9_subcaption_fixed/<run> --save-db
```

### 3. After The Event: Check Scores And Errors

```powershell
npm run event:scores -- --event "Drums Along the Rockies" --season 2026 --refresh
```

This refreshes released scores/recaps, finds the latest saved prediction for the event, backfills actual scores into `model_event_prediction_rows`, and prints total-score error summary.

Important: `event:scores --refresh` skips the ML rebuild unless `--fine-tune` is requested. This keeps score checking fast.

### 4. After The Event: Fine-Tune And Re-Predict

```powershell
npm run event:update -- --event "Drums Along the Rockies" --season 2026 --refresh --fine-tune --update-prediction --model-dir latest
```

This does:

1. season refresh
2. score comparison if a saved prediction exists
3. V9 fine-tune through `seasonUpdateWorkflow.ts`
4. prediction regeneration with the newest V9 candidate model
5. DB save of the new prediction run

Fine-tuned models are candidates. Review eval output before treating a candidate as the new production model.

## Prediction Modes

The canonical feature-availability contract is `src/training/v9FeatureModes.ts`.

The event predictor supports:

- `auto`
- `as_of_show_date`
- `preseason_forecast`
- `panel_unknown`
- `lineup_unknown`

Default is `auto`.

Mode selection in `auto`:

- If there is no same-season ML history before the event date, use `preseason_forecast`.
- Else if fewer than 8 judge assignments map to known judge IDs, use `panel_unknown`.
- Else use `as_of_show_date`.

Manual override:

```powershell
npm run event:predict -- --event "San Antonio" --season 2026 --mode preseason_forecast --save-db
```

Use `preseason_forecast` for May/early June predictions of midseason shows where no same-season ranks/history are known yet.

Use `lineup_unknown` when corps list is known but performance order/field context should not be trusted.

## Data Sources Used

Prediction readiness pulls from:

- `events`: event slug/name/date/time/location
- `competitions`: competition slug, release flags, percent-through
- `event_lineup_entries`: preferred source for lineup and performance order
- `event_participants`: fallback source when lineup rows are missing
- `event_schedules`: final fallback for schedule-like lineup rows
- `judge_assignments`: judge panel, mapped through `src/training/judgeIndexMap.json`
- `ml_sequence_rows_v9_subcaption`: same-season history count and historical templates

The DCI API is still the source of truth for competitions/corps/totals when available. Website recaps fill judge/caption/subcaption detail. Event pages fill upcoming lineup/performance order.

## Saved Prediction Tables

The prediction DB schema is owned by `src/training/v9EventPredictionDb.ts`.

The helper is intentionally idempotent and additive:

- Creates missing prediction tables.
- Adds missing columns for older local DBs.
- Does not drop or rewrite old prediction rows.

### `model_event_prediction_runs`

One row per saved prediction run.

Important columns:

- `prediction_id`: `${event_slug}:${generated_at}`
- `event_slug`
- `competition_slug`
- `season`
- `predicted_at`
- `model_dir`
- `mode`
- `percent_through`
- `lineup_rows`
- `matched_corps_keys`
- `judge_assignments`
- `payload_json`: full JSON output
- `updated_at`

### `model_event_prediction_rows`

One row per predicted corps in a saved run.

Important columns:

- `prediction_id`
- `event_slug`
- `competition_slug`
- `corps_key`
- `corps_name`
- `division_name`
- `predicted_rank`
- `predicted_total`
- `predicted_ge`
- `predicted_visual`
- `predicted_music`
- `predicted_captions_json`
- `template_source`
- `baseline_rank_source`
- `actual_rank`
- `actual_total`
- `actual_ge`
- `actual_visual`
- `actual_music`
- `actual_captions_json`
- `total_error`
- `abs_total_error`
- `updated_at`

Actual category fields are nullable. Missing caption breakdowns are not treated as zero.

## Matching Predictions To Actuals

Post-show comparison matches actual rows by:

1. exact `corps_key`, if present
2. normalized corps name fallback

This is good enough for normal DCI corps. It may be weak for showcase/individual entries, but those should not be part of World/Open production predictions.

## Model Loading

`--model-dir latest` uses `findLatestV9SubcaptionModelDir()` from `src/training/v9ModelPaths.ts`.

It finds the newest directory under:

```text
models/v9_subcaption_fixed
```

that contains a root `model.json`.

For strict reproducibility, pass an explicit model directory.

Inference uses `src/training/v9SubcaptionInference.ts`, which supports:

- final model directories
- checkpoint subdirectories like `best`, `best_composite`, `best_total`, etc.
- embedding ID clipping for newly added corps/judges/shows

## Fine-Tuning Notes

Fine-tuning is delegated to `scripts/seasonUpdateWorkflow.ts`.

The workflow:

- rebuilds ML artifacts with `--as-of-date`
- uses date-forward validation
- loads the source model with `--load-model`
- creates a new candidate model directory

`event:update --fine-tune --update-prediction` uses the newest V9 candidate model after fine-tune completes.

Use `--allow-future-data` only for intentional latest-data runs. Without it, the workflow refuses fine-tune if the DB has released/scored competitions after `--as-of-date`.

## Known Caveats

- The local DB may not have 2026 events until a schedule refresh succeeds.
- Recent event detail can be incomplete from the API; event pages and website recaps are required for lineups/judges/captions.
- Judge assignments are often unknown before the show. The model supports `panel_unknown`; this is expected and not a fatal condition.
- Preseason/midseason future predictions before the season starts are weaker because same-season rank/history is unavailable. Use `preseason_forecast`.
- If a corps has no historical model template, the predictor uses synthetic unknown-corps features. This avoids crashes but should be surfaced in caveats.
- Open Class remains more volatile and usually has fewer rows. Watch per-division error summaries.
- A saved prediction should include `--save-db` if you want post-show error tracking.
- `event:scores` can still report actual score rows even when no saved prediction exists.
- Full `npm run check` may fail on unrelated legacy/training files. For this workflow, script-level TypeScript checks are more targeted.

## Troubleshooting

### Event Not Found

Run:

```powershell
npm run event:check -- --event "<name>" --season 2026 --refresh
```

If still missing, the schedule may not be available from current ingest sources yet.

### Lineup Missing

Try:

```powershell
npm run event:check -- --event "<name>" --season 2026 --force-refresh
```

The predictor checks `event_lineup_entries`, then `event_participants`, then `event_schedules`. If all are empty, it refuses prediction because there is no corps list.

### Judges Missing

This is acceptable. The script uses panel-unknown behavior when fewer than 8 mapped judges are available.

### Scores Missing After Event

Run:

```powershell
npm run event:scores -- --event "<name>" --season 2026 --refresh
```

If actual rows are still zero, the recap/API may not be released yet or the event slug/competition slug may not match.

### Prediction Exists But No Rows Match Actuals

Check:

```sql
SELECT corps_key, corps_name FROM model_event_prediction_rows WHERE prediction_id = '<id>';
SELECT corps_key, corps_name FROM corps_scores WHERE competition_slug = '<slug>';
```

Usually this is a corps-key mismatch or an event/competition slug mismatch.

### Need A Strict Historical Reproduction

Use explicit arguments:

```powershell
npm run event:predict -- --event "<event-slug>" --season 2026 --model-dir models/v9_subcaption_fixed/<run> --mode as_of_show_date --percent-through 50 --save-db
```

Avoid `latest` for reproducibility.

## Suggested SQL

Latest saved prediction runs:

```sql
SELECT prediction_id, event_slug, season, predicted_at, model_dir, mode
FROM model_event_prediction_runs
ORDER BY predicted_at DESC
LIMIT 20;
```

Prediction rows for one event:

```sql
SELECT predicted_rank, corps_name, predicted_total, actual_total, total_error, abs_total_error
FROM model_event_prediction_rows
WHERE prediction_id = '<prediction_id>'
ORDER BY predicted_rank;
```

Average error by event:

```sql
SELECT
  r.event_slug,
  r.predicted_at,
  COUNT(p.actual_total) AS matched,
  AVG(p.abs_total_error) AS mae_total,
  AVG(p.total_error) AS bias_total
FROM model_event_prediction_runs r
JOIN model_event_prediction_rows p ON p.prediction_id = r.prediction_id
WHERE p.actual_total IS NOT NULL
GROUP BY r.prediction_id
ORDER BY r.predicted_at DESC;
```

## Files To Revisit If Behavior Changes

- `scripts/predictEventRecap.ts`: user-facing pre-show readiness/prediction workflow.
- `scripts/updateEventPredictionStatus.ts`: user-facing post-show score/fine-tune/update workflow.
- `src/training/v9EventPredictionDb.ts`: prediction table schema, migrations, save/update helpers.
- `src/training/v9PredictionFeatures.ts`: feature construction and mode masking.
- `src/training/v9FeatureModes.ts`: canonical prediction-mode contract.
- `src/training/v9Baselines.ts`: mode-aware baseline construction.
- `src/training/v9SubcaptionInference.ts`: V9 model loading and single-row inference.
- `scripts/seasonUpdateWorkflow.ts`: refresh, ML rebuild, and fine-tune orchestration.
