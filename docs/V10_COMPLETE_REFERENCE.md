# V10 Prediction Model — Complete Serving, Ops & Integration Reference

**Status as of 2026-07-18:** V10 is fully built, audited, deployed as a **live A/B behind a
feature flag**, and **not yet serving users** (final2 still serves). This is the single
authoritative reference. See also the running notes in the assistant memory
(`v10-model-integration.md`) and the earlier `docs/v10-serving-wip/`.

---

## 1. Executive summary

- **V10** = a multi-seed, identity-agnostic **ensemble** of the clean-data (dev3) trainer.
  Same ~1.03M-param architecture as the previous production model **final2**; its gains come
  from **data + serving**, not architecture.
- **Result (audited, forecasting genuinely-unseen events):** **+30.7% caption accuracy (recap MAE)**
  and **+15.4% final-score (total MAE)** vs final2. Recap is calibration-free; total is raw
  (V10 needs **no** correction layers — see §6).
- **Current state:** final2 serves the live site. V10 writes predictions nightly as an A/B
  (tagged `clean-v10`, invisible behind the `PREDICTION_MODEL=final2` flag default). The flip
  is a one-env-var, fully-reversible feature flag (§4).

---

## 2. Why V10 serving was hard (the core diagnosis)

The V10 models were **trained** on the dev3 clean-data contract (feature profile "v9.5-220-control":
212 raw static + 8 trend). The existing serving path (`predictEventRecap` → `buildV9PredictionFeatures`)
**reconstructs features in the v9 contract**, off by ~48% recap — it does **not** feed the models
what they trained on. The handoff's claim that "serving is already correct, just wire artifacts"
was **false**. The fix was a **new clean-v10 inference/serving path** (§3).

---

## 3. Architecture — the serving pipeline

Four stages. All keep the exact **dev3 / v9.5-220 / identity-agnostic** contract the models trained on.

### A1 — Temporal contract refresh (`prepareV10TrainingData --serving` + `prepareV10TemporalFeatures`)
Rebuilds the `v10_temporal_*` tables (caption features, corps history, judge elo, field pace) from
**live prod data** so serving features have coverage through the latest scored show. `--serving`
skips the frozen-source hash + fixed-7317-row guards (keeps data-quality invariants). Verified: the
fresh contract is **feature-identical** to the frozen one for overlapping rows.

### A2 — Build clean-v10 inference rows for a target event (`buildMlSequencesV9Subcaption --inference-events`)
Injects an upcoming (unscored) event as a target for its lineup corps and builds the exact clean-v10
feature row (no scores needed). Reuses the proven clean-v10 feature computation, so rows match what
the models trained on. Lineup comes from **`classified_event_lineup`** (the announced schedule).

### A3 — Direct-feed serving (`cleanV10Serve.ts`)
Feeds a clean-v10 row **directly** to the identity-agnostic ensemble, mirroring the eval feed
exactly (static[212] + 8 trend slopes, `maskV9JudgeContext`, baseline from the sequence's last-recap
channel with dev3 curve-anchor fallback, all identity scales = 0). Averages the members' caption
p10/p50/p90, derives categories/total, adds p10/p90 uncertainty bands, and writes the standard
`model_event_prediction_runs`/`_rows` payload (`--save-db`) + optional JSON.

### The feature flag (serving selector) — §4
Both models write runs; `PREDICTION_MODEL` selects which is served. No more fragile newest-wins.

---

## 4. The feature flag — flip & rollback

`PREDICTION_MODEL` env var: **`final2`** (default) | `v10` | `any`. Selects the served run by
`model_dir` in BOTH serving paths:
- read-model builder — `sdk/src/readModel/builders/predictions.ts` (the emit; runs on cron, local sdk)
- live fallback — `app/lib/event-prediction-api.ts` (the container; deployed)

Falls back to newest-any if the flagged model has no run for an event (never blank). Default `final2`
= exact current behaviour (verified no-op). Committed to **prod master `8707a6b`**, **deployed**.

**FLIP to V10:**
1. Set `PREDICTION_MODEL=v10` in the **Coolify app env** (redeploy picks it up).
2. Set `PREDICTION_MODEL=v10` in the **read-model emit env** (export in `scripts/refresh-prod-read-model.sh`
   or the nightly/auto-ingest cron env).
3. Republish read-model (`bash scripts/refresh-prod-read-model.sh`) + redeploy the app.

**ROLLBACK:** set both back to `final2`, republish + redeploy. No data change, no run deletion.

**Reversibility layers:** the flag; the verified pre-flip backup (§7); both models' runs persist;
final2 model on disk; off-box nightly DB backup.

---

## 5. Scripts & files reference

### Serving branch `v10-serving` (off master, on the vultr box `/home/patrick/cp-v10-serving`)
- `sdk/scripts/cleanV10Serve.ts` — the direct-feed serving path (§A3). Flags: `--event --db
  --template-table --ensemble-dirs --save-db --output --bias-calibration --as-of`.
- `sdk/scripts/cleanV10BiasCalibration.json` — `{}` (no bias; the fixed bias doesn't generalize, §6).
- `scripts/v10-shadow.sh <days>` — the nightly A/B writer: A1 refresh → A2 build → serve `--save-db`
  (V10 runs to prod, unserved by flag) + JSON forecasts to `/home/patrick/v10-shadow/<date>/`.
- `scripts/v10-shadow-eval.py` — compares V10 vs final2 vs actuals as shadow events get scored.
- `scripts/nightly-v10-predictions.sh` — the full flip-time orchestration (build → serve `--save-db`
  → publish). (The shadow is the A/B variant; this is the "serve it for real" variant.)
- `docs/V10_FLIP_RUNBOOK.md`, `docs/v10-serving-wip/README.md` — earlier runbook + WIP trail.

### Builder branch `codex/v10-model-reconstruction` (worktree `/home/patrick/cp-branch`)
- `sdk/src/buildMlSequencesV9Subcaption.ts` — the clean-v10 builder; `--data-contract clean-v10`,
  `--inference-events`, `--as-of`, `--table`, `--db`, `--output-db`.
- `sdk/scripts/prepareV10TrainingData.ts` — `--serving` mode (A1).
- `sdk/scripts/prepareV10TemporalFeatures.ts` — temporal contract (unmodified; self-consistent).
- **Pushed to branch **`v10-serving-builder`** (kept off the shared codex branch to not disrupt the running v10.1 instance; merge into `codex/v10-model-reconstruction` when v10.1 settles).
  mini-PC / others get the A2 + serving-mode fixes.

### Prod master `/root/corps-place`
- `sdk/src/readModel/builders/predictions.ts`, `app/lib/event-prediction-api.ts` — the flag (`8707a6b`, pushed + deployed).
- `scripts/nightly-predictions.sh` (final2 nightly), `auto-ingest-scores.sh`, `refresh-prod-read-model.sh`,
  `deploy-on-new-image.sh` (digest-watcher deploy) — unchanged prod ops.

---

## 6. Model behaviour findings (what V10 needs)

- **No correction layers.** final2's forward-projection / comparable-revert / P2-blend patch a
  MODEL-AGNOSTIC mid-season bias. Served on its own contract, V10 bakes the seasonal projection into
  its features and needs none. The residual bias is **season-specific** (2025 and 2026 have opposite
  signs) — a fixed bias term overfits in-sample or hurts out-of-sample, so serving default = **raw**.
- **Serve identity-agnostic.** Stored corps/judge/show embeddings hurt out-of-sample; all identity
  scales are zeroed. This also makes the corps/judge index maps irrelevant to correctness.

---

## 7. Data, artifacts, backups

- **Models (12 members):** `sdk/models/v10_clean_data_control/*` (8 seeds) + `v10_phase_aware_lr/*` (4).
  Git-ignored; source of truth is the verified tarball on the mini-PC `C:/Users/Patrick/v10-handoff.tar.gz`
  (sha256 `88a8a545…`). The shadow uses a fixed 5-seed subset (control 42-46) for box-friendliness.
- **dev3 contract artifacts:** `sdk/src/training/v10/dev3/` (curves + maps), committed on the branch.
- **Temporal contract in prod:** `v10_temporal_*` + `v10_training_performances` tables in the prod DB
  (refreshed from live data by A1). `ml_sequence_rows_v10_inference` = the current inference rows.
  All ADDITIVE — final2 reads `ml_sequence_rows_v9_subcaption`, untouched.
- **Pre-flip backup:** `/home/patrick/pre-v10-flip-backup-2026-07-18T180105Z/` — final2 predictions
  + live read-model + config, decompress-verified, with restore steps in its `MANIFEST.md`.
- **Off-box:** prod DB backed up nightly 05:00 (restic/R2).

---

## 8. Ops & monitoring

**Crons (vultr):**
- `03:30` final2 nightly predictions + publish (`nightly-predictions.sh`)
- `* * * * *` auto-ingest scores → regen future predictions + publish (`auto-ingest-scores.sh`)
- `04:15` **V10 A/B shadow** (`v10-shadow.sh 11`) → V10 runs + JSON forecasts
- `05:00` DB backup; `*/2` digest-watcher deploy

**Monitor V10:**
- `python3 /home/patrick/cp-v10-serving/scripts/v10-shadow-eval.py` — V10 vs final2 vs actuals as
  shadow events resolve (first resolves 2026-07-19). This is the forward-test evidence for the flip.
- Logs: `/home/patrick/v10-shadow/v10-shadow.log`, `.../cron.log`; forecasts in `/home/patrick/v10-shadow/<date>/`.

---

## 9. Bugs found & fixed (audit trail — most were invisible to offline validation)

Two heavy audits (161-row cohort, feature-fidelity) used **scored shows as stand-ins**, so they
MISSED the bugs that only appear when forecasting **real future events**. The live shadow caught them.

1. **`--as-of` string-date boundary** — bare date excluded same-day shows; corrupted history for corps
   competing on the as-of day. (validation-only) `90207aa`.
2. **Empty future-event forecasts** — lineup read from `corps_competition_results` (scored-only) → 0
   rows for future events. Fixed to `classified_event_lineup`. `1e21616`.
3. **Cross-event history pollution** — building multiple upcoming events together, a corps' earlier
   (unscored) targets polluted its later ones → garbage forecasts. Fixed: `pastShows` excludes
   `is_inference` shows. `b56c519`.
4. **Feature-contract mismatch (the core one)** — serving fed the v9 contract, not dev3; fixed by the
   whole clean-v10 direct-feed path. **In-sample bias overfits** — dropped. **5 GB nightly hash** — dropped.

Post-fix validation: all upcoming events sane (WC 71–92, OC 58–75, WC>OC), tops = actual elite corps,
each corps consistent across events with slight date-growth, debuts reasonable.

---

## 10. v10.1 training (in progress, mini-PC)

An autonomous Claude Code instance runs in the mini-PC WSL (launched via a Windows Scheduled Task
`v10_1_training`, `IS_SANDBOX=1`) to train **v10.1** — a V10 retrain that ADDS some 2026 data (V10
held out 2026 entirely). Handoff: `/root/v10.1-handoff.md`; live status: `/root/v10.1-status.md`
(both in mini-PC WSL). It works on branch `codex/v10-model-reconstruction`, keeps an honest held-out
2026 slice, and must preserve the v9.5-220 contract so it drops into this serving pipeline unchanged.

---

## 11. Recommended path to flip

1. Let the shadow accumulate a few days of **resolved** upcoming shows; check `v10-shadow-eval.py`.
2. If V10 beats final2 on those genuinely-unseen events, flip the flag (§4).
3. Watch a day; rollback is instant if anything looks off.

## 12. Known caveats / open items
- Interval widths use raw ensemble spread (scale=1); a history/division interval calibration (4f)
  would widen them. Means are correct.
- Push the `codex/v10-model-reconstruction` builder commits (see §5).
- The Coolify deploy-token rotation flagged earlier is still PENDING (unrelated to V10).
