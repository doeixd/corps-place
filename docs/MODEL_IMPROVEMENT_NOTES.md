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

---

## 6. Hard-won context for whoever builds V10 (not obvious from the code)

*These are lessons and gotchas discovered debugging V9 in production over
2026-07. They will save you days and stop you re-running experiments that already
failed. Dates are when each was established; verify against current code before
relying on a specific line number.*

### 6a. Experiments already run — DO NOT redo these (negative results)

- **Learned "debut prior" — reverted (2026-07-06).** A learned opening-night
  anchor for 0-show debut corps looked great (LOO MAE 3.1) but only vs a
  *strawman* (raw prior-season-best, MAE 17.3). Tested fairly against the logic
  production actually uses (`getPriorSeasonComparableTotal` = last-year score at
  closest percent-through), the existing anchor was already 3.41 vs the prior's
  3.14 — a meaningless gain — and end-to-end it *regressed* corps the comparable
  already nailed (Blue Stars 77.6→72.8 vs actual 77.4). **Lesson: validate every
  prediction change end-to-end against the real deployed path, never an isolated
  strawman.**
- **Full v4.1 reference-curve swap — definitively rejected (2026-07-08).** v4.1
  improves `target` mode but *regresses the shipped P2 ensemble* (+0.155 MAE
  worse), because the ensemble is `persistW·persist + (1−persistW)·(target+curveΔ)/2`
  and curveΔ regresses more than target improves. **Judge any curve change on the
  ENSEMBLE, never on `target` mode alone.** (The one exception that shipped was a
  *surgical VA-only* column patch — see 6c.)
- **Recomputing the stale rank features (rankEma/rankVsHistorical, idx 9/13) —
  noise, don't ship (2026-07-08).** They're frozen at template-show time, but
  recomputing them from as-of-target standings desyncs them from the still-
  template-time residual block; backtest was a wash. Only the self-contained
  cold-start block (169–178) is worth recomputing for the target.

### 6b. Traps when *measuring* model accuracy (you will hit these)

- **`backtestPredictionModes.ts` can slander the model.** Its curve/target modes
  feed the model a *reference-curve* `baselineRecap`, but the model is trained to
  predict a delta from the corps's *recent-form* baseline (last valid step's
  captions, with dropout/noise augmentation). Feeding curve baselines is
  out-of-distribution and makes the model look 5–15 pts worse than persist — an
  artifact, not a finding. Any mode comparison must feed the real recent baseline.
- **Re-running `predictEventRecap` on an already-scored event LEAKS the actuals**
  into the prediction. To judge accuracy, use the frozen-cutoff backtest harness
  or `--as-of <date>` (freezes knowledge before the show) — never a live re-run
  on a scored event.
- **The canonical "is the model better than persist?" answer is
  `final_validation_vs_inertia_pts` in the model card: yes, by 0.81.** Do not
  de-weight the model vs persist based on a bad backtest mode.
- **Model looks wrong? Check data FIRST, then regime, before the model.**
  Order: (1) data completeness — partial multi-division ingestion silently drops a
  class (the 2026-dci-west fiasco; there's a completeness gate in
  `auto-ingest-scores.sh` now); (2) regime — debut / early-season is the model's
  *only* weak zone (preseason MAE ~1.7, debut ~3.6); (3) only then suspect logic.

### 6c. Data-quality landmines a retrain MUST heed *(directly relevant to V10)*

- **`caption_scores` (the training/feature source) is contaminated.** ~1250 poison
  rows: full totals (80–99) stored in Music/Visual *subcaption* cells
  (2017–2019), 0.0 DNP sentinels treated as real, and 3 rows with a judge name in
  `caption_name`. **The V9 subcaption builder still reads raw `caption_scores`, so
  V9's training features may include this contamination — a clean rebuild is the
  natural next hardening.** For V10, read the clean domain **VIEW
  `clean_reference_curve_metric_scores`** instead of the raw table — it
  name-normalizes (kills the VA drift below), drops I&E/individual/showcase, drops
  zeros/DNP, and keeps only sum-reconciled rows (`ABS(caption_total −
  total_score) ≤ 0.05`). Full writeup: `docs/DATA_QUALITY_NOTES.md` §11.
- **Caption-name gotcha:** the DB stores `"Visual - Analysis"` (hyphenated, like
  `"Music - Analysis"`) — there are **ZERO** `"Visual Analysis"` rows. Any code
  with the no-hyphen key silently drops the entire VA caption (this corrupted the
  reference curve once). The subcaption builder maps both forms; make sure any new
  feature code does too. (DB caption for the model is `"Visual - Analysis"`.)

### 6d. Feature/inference invariants that must not drift

- **The static vector is 212-wide:** 169 base + 10 cold-start [169–178, incl.
  `percentThrough` at 178] + 33 caption-fingerprint [179–211]
  (`V9_RAW_STATIC_DIM`). A builder that emits only the 169 base silently zero-fills
  cold-start on every in-season prediction — a real bug we hit (2026-07-08). Guard
  tests: `sdk/test/v9FeatureParity.test.ts` and `v9InferenceParity.test.ts`
  (byte-exact builder↔inference parity) — run them before/after any feature change.
- **The cold-start block (169–178) must be recomputed for the TARGET** on all
  templates (same-season templates are the corps' *last* show, so leaving them
  stale feeds the wrong percentThrough/shows-count → conservative early-season
  bias). Fixed byte-exact in `46ed382`.
- **NEVER regenerate the frozen index maps** (`{corps,judge,show}IndexMap.json`)
  for inference — indices are positional and baked into the trained embeddings;
  new corps correctly fall back to index 0. `final2` expects specific map hashes.
- **`V9_FEATURE_INDICES.pastShowsCount` is 136**, not 168 (168 holds a subcaption
  EMA). A wrong index here makes `maskV9PreseasonForecastContext` zero the wrong
  slot (was a real bug, fixed).

### 6e. On the P1 field-pace feature specifically — a warning from the `percent_through` saga

`competitions.percent_through` was itself a data-definition bug (2026-07-07):
it read as *rank-among-scored-events* (k/N) rather than calendar progress, so in
an in-progress season every event pinned toward 100% ("finals-level") and the
model over-read early-season events. It's since anchored to the **scheduled
finals** (`MAX(events.start_date)`, 2026 schedule runs through 2026-08-08). Two
takeaways for a field-pace feature:
1. **Any season-progress or field-pace input must be calendar/schedule-anchored,
   computed identically for complete and in-progress seasons** — or the model
   sees a different distribution in production than it trained on.
2. **Right-size the expected impact.** The percent_through fix looked huge in a
   forced-`pct=100` backtest (+8–19 pts) but moved live predictions only ~+0.22
   mean, because it's one lightly-weighted feature of 101/step and the live path
   already used the calendar fallback. A field-pace feature is more central, but
   validate its *live* effect (frozen-cutoff walk-forward), not just a synthetic
   sensitivity sweep.
