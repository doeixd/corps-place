# V9 → V10 model improvement notes

*Written 2026-07-15, after a run of in-season prediction misses (notably Carolina
Crown at DCI Broken Arrow) forced two post-hoc correction layers onto the frozen
V9 model. This doc is the to-do list for the next model: each correction we
hand-coded should either be folded into a feature / training change or kept as a
deliberate, documented calibration layer — not left to accrete.*

Related: `docs/PREDICTION_FEATURE_CODE_REVIEW.md`, the memory
`prediction-pipeline-architecture.md`, and the model card under
`sdk/models/v9_subcaption_fixed/v9_prod_fingerprint_preseason_final2_*/`.

---

## 1. Where we are

**The model is strong where it has data.** V9 (LSTM 128→64 over an 8-subcaption
sequence, predicting per-caption *residuals against a reference curve*) hits
**test total MAE 0.71**, beating inertia by 0.81 and a quadratic fit by 0.30.

**It is weak exactly at the thin-data edge** — and its own card says so:

| regime | total MAE |
|---|---|
| overall (test) | 0.71 |
| preseason forecast | ~1.7 |
| zero history | ~3.2 |
| season debut | ~3.6 |

Every post-hoc correction we've added lives in that tail.

### Corrections currently bolted on (the "calibration layer")

1. **Gentle in-season bias correction** (commit `3d5bf03`). Subtracts a damped
   (×0.67), capped (±1.25) running-mean signed error from history≥1 corps. Exists
   because 2026's season is more *compressed* than V9's training seasons
   (2022–25), so the field improves faster per week than the model ever saw — a
   frozen model structurally can't know this. Applied at serving time.
2. **Thin-history revert-to-comparable** (commit `a5a6abd`). For corps with 1–3
   in-season shows, blends the prior-season comparable back into the target
   (.50/.30/.15 by show count). Exists because the model over-anchors to recency
   when history is thin (see §2).

Both are **walk-forward validated on 2026 actuals** (bias: thin-history 1.34→0.80
at full strength; revert: overall field 1.69→1.59, no regression) and are small,
capped, and targeted. That discipline is what keeps them from being hacks. But
two corrections is the ceiling before this should become model work.

---

## 2. Root causes (what the corrections are really compensating for)

**Prior-season information is already in the model.** This was a key finding —
we are *not* missing the feature:
- the **LSTM sequence spans seasons** (there's a `normalizeOffseasonGap`
  feature); Crown's Broken Arrow prediction had `observed_history_len: 16` with
  just one 2026 show — the other ~15 steps are its 2025 season;
- a **preseason caption fingerprint** (33 dims — the model is literally named
  `fingerprint_preseason`);
- **historical-rank features** (`previousRank`, `meanRank`, `rankEma`,
  `rankVsHistorical`);
- the rank baseline can be seeded from `prior_season_rank`;
- a learned **per-corps embedding** capturing cross-season identity/strength.

So the model *holds* Crown's pedigree. The failure is **recency over-anchoring**:
it predicts a residual *against the last recap* (82.1), and an LSTM's final state
is dominated by its most recent step — so one fresh in-season observation
overrides 15 steps of prior-season context. For a corps with 8 shows that
recency bias is *correct* (it's why the strong-zone MAE is 0.71). For a corps
with one show it's noise, and the model should fall back on prior season — but it
wasn't trained on enough thin-history examples to learn that fallback.

**Two distinct problems, then:**
- **(A) Season-pace drift** — a frozen model can't adapt to how fast *this*
  season's field is moving. → the bias correction.
- **(B) Recency over-anchoring on thin history** — the model has prior-season
  signal but discounts it when in-season history is short. → the comparable-revert.

---

## 3. Proposed improvements (prioritized)

### P1 — Field-pace feature: "how fast is the field moving this season" *(addresses A; retires the bias correction)*

**Idea (from the field slope discussion):** give the model an observable,
per-date signal of the current season's tempo, so it can *learn* to adjust
individual forecasts to a fast/slow season instead of us hand-tuning a fixed
offset.

Concretely, as a small block of **static features shared by every corps at a
given prediction date** (a field-level, not corps-level, signal):
- **field level vs. reference curve** — mean (top-25) total observed so far this
  season minus the reference-curve expectation at the same percent-through
  (positive = the field is running hot);
- **field slope so far** — points/percent-through of the top-25 (or top-N by
  division) fitted over the season's observed shows to date (how steep the ramp
  is);
- optionally the **residual-EMA of the field** (average of corps' own
  residual-vs-curve to date) — the aggregate version of the per-corps
  `residualEma` we already have.

Why this is the right shape:
- It generalizes the bias correction from a *scalar offset* to a *learned
  response to a measurable covariate*. A compressed season shows up as a steeper
  field slope; the model can learn how that maps to individual deltas.
- It's leakage-safe if computed strictly from shows **before** the target date.
- Restrict to the **top-25** (or a stable competitive core) so it isn't dragged
  by the volatile long tail / debuts.

Cautions:
- **Early season the slope estimate is noisy** (few shows). Shrink it toward the
  historical-average field slope with weight ∝ observed sample size, so the
  feature degrades gracefully to "typical season" when there's little data.
- Must be **division-aware** (World vs Open ramp differently) — compute per
  division, or feed division as an interaction.
- Validate that it doesn't just re-learn the target — it should be a *context*
  feature, same value for all corps at a date.

If this works, the manual bias correction can be **retired** (or kept only as a
thin safety cap).

### P2 — Train on more thin-history examples *(addresses B)*

The debut/thin-history regime (3.2–3.6 MAE) is under-represented: most training
rows are mid/late-season with rich history. Two complementary moves:

- **History-truncation augmentation.** For each corps-season, emit training
  instances "as of show 1, 2, 3, …", not just the full-history view. This
  manufactures many more legitimate thin-history examples from existing data and
  teaches the model the 1-show / 2-show regime directly.
- **Loss reweighting.** Upweight early-in-a-corps's-season positions in the loss
  so the optimizer stops treating them as rounding error behind the data-rich
  majority.

### P3 — Soften the last-recap anchor for thin history *(addresses B; retires the comparable-revert)*

The residual is computed against `baselineRecap = last recap`, hard-coding
recency. For corps with 1–3 shows, compute the residual against a **blend of
last-recap and the prior-season comparable** instead (the same blend the
comparable-revert applies post-hoc, but at *training and inference* time so the
model learns residuals against the better anchor). If P2 + P3 land, the
comparable-revert correction folds away.

### P4 — History-aware interval width *(coverage)*

Crown's interval was 80.9–83.6; actual 87.15 sat **3.5 pts above p90**. The
`interval_scale` (0.6) is global, so thin-history / high-uncertainty corps get
intervals as tight as data-rich ones. Make interval width a function of history
depth (and/or field-slope uncertainty): wider when thin. This is the honesty fix
— a 1-show forecast *should* advertise a wide band.

### P5 — In-season recalibration cadence *(ops, addresses A)*

Even with P1, a frozen artifact drifts. Options, cheapest first:
- a light **output-layer / global-offset recalibration** on the current season's
  accumulated results (safe, fast, reversible) — a principled version of today's
  bias correction;
- periodic **fine-tuning** of the full model mid-season (higher risk; gate behind
  the backtest).

---

## 4. Validation protocol (don't skip)

- **Standing rule:** rerun `sdk/scripts/backtestPredictionModes.ts`
  (2025 replay, cutoffs Jul 1/15/30) before shipping any prediction-logic change,
  and compare MAE/bias to the recorded baselines in
  `prediction-pipeline-architecture.md`.
- **Plus** a 2026 walk-forward on real actuals for the specific change (the method
  used for both corrections this session): last pre-show prediction per (show,
  corps) vs. actual, sliced by history depth. New-feature changes especially must
  show **no regression on the data-rich majority**, not just a thin-history win.
- **Leakage discipline:** every field-pace / comparable input must use only shows
  strictly *before* the target date. The frozen index maps
  (`{corps,judge,show}IndexMap.json`) must **not** be regenerated for inference.

## 5. Retire-when-done tracker

| post-hoc correction | folded in by | retire when |
|---|---|---|
| in-season bias correction (`3d5bf03`) | P1 field-pace feature (+ P5 recal) | field-slope feature validated, bias→~0 |
| thin-history comparable-revert (`a5a6abd`) | P2 + P3 | thin-history MAE matches without the blend |

The goal is a V10 where the calibration layer is **empty or a thin safety cap** —
the model has learned what we're currently hand-coding.
