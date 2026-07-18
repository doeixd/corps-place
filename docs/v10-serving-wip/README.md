# V10 serving — status & remaining work (Phase A2/A1)

## Where it stands (2026-07-18)
The V10 serving fix is **proven**: `sdk/scripts/cleanV10Serve.ts` feeds the clean-v10
contract directly to the ensemble and recovers full model quality —
**recap 0.303 (vs final2 0.438, +31%), total 0.873 raw (vs final2+corr 1.046, +17%)**
on the 8-show/65-corps shadow — WHEN a clean-v10 feature row exists for the target
event. That holds today for scored shows (they're in `ml_sequence_rows_v10_serving_clean`,
copied from the dev DBs).

The gap is **forecasting UNSCORED future events**: no clean-v10 row exists for them,
and a stale prior row + surgical projection fails (as-of path = recap 0.568, worse
than final2) because the prior row's history is one show short and its target context
is wrong.

## The remaining build

### A2 — emit a clean-v10 inference row for a target event
Extend the clean-v10 builder (`buildMlSequencesV9Subcaption.ts --data-contract clean-v10`)
to build a target row from the event's lineup + history, no scores. **The corpsMap
injection is written** and saved in `A2-inference-injection.patch` (adds
`--inference-events <slugs>` + `--as-of`, queries lineup from `corps_competition_results`,
injects each event as the latest targetShow for its lineup corps). Still TODO in that
patch's file:
- Make the temporal lookups tolerate an inference target that has no `v10_temporal_*`
  row: `temporalCaptionFor` must return undefined instead of throwing so `baselineFor`
  falls back to `getBaseline` (the dev3 curve = the correct reference_baseline). Do the
  same for `v10_temporal_field_pace` (~L2014), corps/judge elo, corps_history — each
  either falls back to a pre-event computation or is masked (panel unknown).
- Insert the inference row (empty captions → y_recap already defaults to 0); tag its
  `split` so it's identifiable.
- **This work must be done in the full branch / dev environment** (`codex/v10-model-reconstruction`,
  or the mini-PC WSL `/root/corps-place-v10`): the clean-v10 builder needs branch-only
  deps (`querySeasonCaptionsV10Clean` in mlQueries, v10FeatureSchema/Config) that are
  NOT on master, so it does not compile in this `v10-serving` worktree.

Validate A2 by holding out a scored show: build with `--as-of <eve> --inference-events <show>`
and confirm the injected row's x_static matches the real clean_control row for that show
(they should match — clean_control rows are already leakage-safe).

### A1 — materialize/refresh the temporal contract in prod
`prepareV10TrainingData` → `prepareV10TemporalFeatures` build `v10_temporal_*` from a
source snapshot. For fresh serving these must run nightly on live data (they read
`corps_competition_results` etc.). The temporal rows for inference targets fall back to
dev3 curves (A2), so A1's main job is keeping the HISTORY-derived temporal features
(corps_history, elo, field_pace) fresh through the latest shows.

### Then
Feed `cleanV10Serve`'s clean captions into the existing forward-projection + correction
layers (bias-correct / P2 blend — KEEP them) for the served total, and flip via
`nightly-predictions.sh` (see `../V10_FLIP_RUNBOOK.md`).

## Inert prod-DB tables (drop anytime)
`ml_sequence_rows_v10_serving`, `ml_sequence_rows_v10_serving_clean` — only read when
`--template-table` points at them.

---

## UPDATE 2026-07-18 — Phase A2 DONE & VALIDATED end-to-end

`--inference-events` now builds faithful clean-v10 rows for unscored target events
(branch commit eb37653). Three fixes: temporal-lookup tolerance (→ getBaseline
fallback), skip is_inference in opponent history, **populate competitionMap for the
inference event** (the key fix). Central-texas inference row matches its real
clean_control row on every major block (0.000) and serves identically.

Full 8-show re-shadow, V10 served via A2 inference rows (TRUE forecasting, no target
scores): **recap 0.326 vs final2 0.438 (~26% better)**; total 1.017 vs 1.046 raw.
Matches the proof path (0.303). The V10 forecasting pipeline works end-to-end.

### Remaining (productionization only)
1. **Wire correction layers onto the A2 captions** — feed cleanV10Serve's clean
   captions into the existing forward-projection + P2 blend + bias-correct (KEEP them)
   for the served total (recap already +26%; total will follow).
2. **A1 nightly refresh** — prepareV10TrainingData/prepareV10TemporalFeatures must
   rebuild v10_temporal_* in prod nightly on fresh data (current copy frozen 07-17).
3. **Nightly wiring + flip** — build inference rows for upcoming events each night,
   serve, publish; flip per V10_FLIP_RUNBOOK.md.

Inert prod tables (drop anytime): ml_sequence_rows_v10_serving, _serving_clean,
_inference; v10_temporal_* + v10_training_performances (feed the builder — keep if
pursuing productionization).
