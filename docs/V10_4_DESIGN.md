# V10.4 — Design Doc: Fix the Range-Compression Under-Prediction

**Status:** proposal / not yet trained. Authored 2026-07-19.
**Owner:** (to be assigned to a mini-PC training instance).
**One-line:** V10/v10.2/v10.3 systematically under-predict the top of the field; the cause is
**range compression from the squared-error objective (+ a truncated training window), NOT a
missing feature.** V10.4 fixes it on the **loss / calibration / data** side.

Read alongside `MODEL_IMPROVEMENT_NOTES.md` (P1–P5), `V10_COMPLETE_REFERENCE.md`, and the
v10.1/v10.2/v10.3 status logs (`/root/v10.{1,2,3}-status.md` on the mini-PC).

---

## 1. The problem (evidence)

Forecasting the 2026 DCI Southwestern Championship (07-18) **as-of 07-17** — genuinely
out-of-sample for every model — all three under-predict, and the miss is **concentrated at the
top of the field**:

| model | total MAE | signed bias | de-biased MAE | Spearman | exact placements |
|---|---|---|---|---|---|
| V10 (no 2026)            | 1.79 | **−1.73** | 0.93 | 0.989 | 11/22 |
| v10.2 (+2026 ≤07-11)     | 1.98 | **−1.91** | 1.05 | 0.986 | 10/22 |
| v10.3 wave-1 (field-pace)| 1.83 | **−1.81** | 1.02 | 0.991 | 12/22 |

Per-corps error (predicted − actual), sorted by actual score:

| corps | actual | error (V10) |
|---|---|---|
| Blue Devils     | 90.83 | **−4.83** |
| Bluecoats       | 93.05 | −3.33 |
| Carolina Crown  | 90.42 | −3.02 |
| … (middle) …    |       | −1 to −2 |
| The Academy     | 76.0  | −0.19 |
| Gold            | 70.47 | **+0.03** |
| Arsenal         | 64.38 | **+0.20** |

**Signature:** biggest miss at the top, ~zero at the bottom → the predicted *range is narrower
than reality*. Ranking is near-perfect (Spearman ≈0.99); the model knows the order, it just
**compresses the spread** and centers the field too low.

## 2. Root cause — and what it is NOT

### It is NOT a missing-information problem (ruled out 2026-07-19)
The served model is fed essentially all prior-season/trajectory/calendar signal. The **only**
things zeroed at identity-agnostic serving are the learned **embeddings** (corps/judge/show
lookup vectors) and the **judge-Elo** block (`maskV9JudgeContext`). Everything computed is fed,
incl.: `last_season_final_score/rank`, `previous_season_rank`, `historical_mean/best_rank`,
`rank_vs_historical`, `made_finals_rate`, the per-caption `caption_fingerprint`
(`prior_season_residual`, `three_year_residual`, `growth`), `residual_ema`, `residual_slope`,
`days_since_last_match`, `target_percent_through`, `shows_remaining`, `is_season_debut`.
→ **P3 (anchor-blend) is a reparameterization, not new info, and it targets the *thin-history*
regime — but the miss here is on the *richest-history* corps.** P3 is not the fix for this bias.

### It IS a loss / calibration / data problem
Two compounding causes:
1. **MSE mean-reversion (primary, affects all V10 variants).** Squared-error training pulls
   predictions toward the conditional mean of the field, shrinking the top and lifting the
   bottom — exactly the observed error slope. Ranking is preserved; spread is not.
2. **Truncated training window (v10.2/v10.3-specific).** Trained on 2026 only through 07-11, so
   the *target distribution tops out at mid-July levels* — the model has never been asked to
   output championship-high numbers and can't extrapolate to them. (V10 trained on full seasons
   still compresses, so this is additive, not the whole story.)

## 3. What V10.4 changes

Ordered by expected impact. Keep the identity-agnostic, servable v9.5 contract; **field-pace
(P1) stays in** (it helps ranking and is cheap); this doc is orthogonal to it.

### C1 — Spread-preserving / high-end-aware loss (primary)
The core fix. Options, evaluate in this order:
- **High-end reweighting:** upweight training rows in the loss ∝ their (field-relative) score /
  championship-proximity, so the optimizer stops treating the top of the field as tolerable
  rounding error. Cheapest change; likely most of the win.
- **Asymmetric loss:** penalize under-prediction more than over-prediction (e.g. quantile/pinball
  at τ>0.5 on the total, or an asymmetric Huber). Directly attacks a *signed* bias.
- **Rank/spread regularizer:** add a term that penalizes compression of the predicted field
  spread vs actual (e.g. match predicted vs actual field std, or a listwise ranking loss).
- **Predict-absolute ablation:** as a diagnostic, train a variant without the last-recap anchor
  (predict total directly) to measure how much the anchor+MSE combo is responsible for the
  compression. Not necessarily shipped; informs C1.

### C2 — Full-season training data (drop the truncation)
Train through **all available 2026** (and, when the season completes, the August finals) so the
target range includes championship-level scores. Combine with the v10.2 finding that adding 2026
data helps recap (+5.1% held-out). Keep an honest late-season holdout for eval (§5).

### C3 — Principled recalibration (P5)
A light, reversible **output-layer / per-division-and-percent-through offset+scale recalibration**
fit on the season's accumulated results — the principled version of final2's scalar bias hack.
Corrects residual level/spread drift a frozen artifact can't. Gate behind the backtest; keep as a
thin safety layer even if C1/C2 largely solve it.

### Explicitly NOT in V10.4
- **P3 anchor-blend** — wrong target for this bias (thin-history, not top-of-field); still deferred
  pending the train+serve blend wiring (see v10.3 status).
- Re-enabling identity embeddings — they overfit out-of-sample (the reason for identity-agnostic).

## 4. Success criteria
On a genuinely out-of-sample late-season holdout AND the Southwestern-style as-of replay:
- **Signed total bias → ~0** (from ~−1.8), *without* inflating de-biased MAE.
- **Top-of-field miss shrinks specifically:** error no longer correlates with actual score
  (regress error on actual → slope ≈ 0). This is the direct compression check.
- **Predicted field spread ≈ actual** (ratio of predicted-std to actual-std → ~1, from <1).
- **No regression** on recap MAE or ranking (Spearman stays ≥0.98) on the data-rich majority.

## 5. Validation protocol (don't skip; per MODEL_IMPROVEMENT_NOTES §4)
1. **Frozen-cutoff backtest** (`backtestPredictionModes.ts`, 2025 replay, cutoffs Jul 1/15/30):
   compare MAE/bias to recorded baselines; watch bias AND spread ratio.
2. **2026 walk-forward:** last pre-show prediction per (show, corps) vs actual, sliced by field
   position (top-8 / mid / bottom) — the compression must shrink at the TOP specifically.
3. **Head-to-head as-of replay** vs V10, v10.2, v10.3 on the same held-out shows (reuse the
   Southwestern harness: build field-pace + control template as-of the pre-show date, serve each
   ensemble, score vs actuals). 8 seeds each for parity.
4. **Leakage discipline:** every input strictly from shows *before* the target date; do **not**
   regenerate the frozen index maps for inference (only when shipping a matched new model).

## 6. Implementation logistics
- Branch `codex/v10.4-<loss>` off the v10.3 branch (inherits field-pace + the dev-contract infra).
- Trainer: `trainModelV10Final.ts` (reconstructed & working — V10/v10.1/v10.2/v10.3 trained fine).
  C1 is a loss change there; expose flags (e.g. `--high-end-weight`, `--asym-tau`,
  `--spread-reg`) so variants are A/B-able without code edits.
- Data: build a `dev7` contract = field-pace profile + full-2026 (no 07-11 truncation), dev3
  curves/maps, honest late-season holdout. Reuse the verified append trick (dev = clean_control
  ++ field-pace tail; see v10.3 status) to avoid multi-hour Elo rebuilds.
- CONTROL lane only (phase-aware-lr is buggy with date-gated training — proven on v10.1).
- **Self-running driver** (train → eval → REPORT → auto-commit/push) — the -p session exits after
  launch; do NOT rely on being notified (lesson from v10.1; v10.2/v10.3 do this correctly).
- Run the 4-way (V10/v10.2/v10.3/v10.4) eval + the as-of Southwestern replay; write the verdict.

## 7. Risks & open questions
- **Asymmetric/high-end loss can over-correct** into over-prediction or hurt the mid/bottom —
  hence the "no regression on the majority" gate and the spread-ratio metric (not just bias).
- **Recalibration (C3) needs enough resolved 2026 shows** to fit stably; early-season it's noisy —
  shrink toward identity when sample is thin.
- **Anchor interaction:** if C1 alone doesn't decompress, the last-recap anchor + MSE combo may be
  the culprit — the predict-absolute ablation (C1) tells us, and could motivate revisiting the
  anchor (where P3's machinery could then be repurposed for spread, not just thin-history).
- **Range vs calibration confound:** top corps genuinely peak hardest into finals; some of the
  "compression" is real late-season growth the model under-projects. Both point to the same fixes
  (loss + data + recal), so the remedy is unchanged, but interpret the spread metric with this in
  mind.

## 8. TL;DR
The under-prediction is a **range-compression artifact of the MSE objective** (amplified by a
mid-season training cutoff), on a model that **already has all the features it needs**. Fix it
with a **spread-preserving/high-end-aware loss + full-season data + a principled recalibration** —
not with more features and not with P3. Prove it by driving signed bias→0 and predicted-spread→
actual **without** hurting ranking or the data-rich majority.
