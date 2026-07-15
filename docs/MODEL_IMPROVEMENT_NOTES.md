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

#### Why the model doesn't already learn hot/cold season (it has *some* of the data)

A fair objection: the model already gets, at each sequence step, an **opponent
summary** (`opponent last-3 totals + per-caption stats`, rank-weighted top-3;
`OPPONENT_TIMESTEP_FEATURES` in the builder) plus `fieldSize`, `showsRemaining`,
`divisionStrength`, and the season features — so why can't it infer "the field is
running hot this year" on its own? Four reasons, none of which is "missing data":

1. **The signal is opponent-*relative* and *local*, not field-global-vs-curve.**
   The model sees "the corps I happened to face scored X," not "the entire field
   is +2 vs the historical reference curve this season." Detecting a season-pace
   regime means aggregating the *whole field's* deviation-from-curve across corps
   and time — but a per-corps LSTM processes one corps's sequence per forward
   pass and never sees the field trajectory as a measurable object. The
   ingredients are present but scattered across per-show opponent snapshots.
2. **It's a weak second-order effect competing with a dominant one.** Per-corps
   recency explains most of the score and most of the loss; the season-pace tilt
   is ~1.2 pts. The optimizer spends capacity where it buys the most MAE (per-corps
   dynamics) and under-fits a noisy field-wide signal that's expensive to extract
   for little loss reduction.
3. **The reference curve assumes a normal-pace season.** The curveΔ growth leg
   projects improvement off historical-average curves and is added *post-hoc*
   (not residual-absorbed), so a faster season under-shoots there by construction.
4. **Possible out-of-distribution.** If 2026's compression exceeds the pace
   variance in 2013–2025, the model never saw enough "hot season → corps up X"
   contrast to learn a strong response.

This is precisely the case for an **explicit, pre-computed** field-slope feature:
it hands the model the *finished aggregate* (field level + slope vs. curve) so it
doesn't have to synthesize it from opponent snapshots — the applied-ML move you
make when "the data is all there" but the architecture still can't use it. The
catch: it only pays off if you **retrain** with it (a frozen model won't respond),
and only if the training seasons vary in pace enough to learn the mapping — pair
it with P2's augmentation so the relationship is well-represented.

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

---

## 7. Retraining logistics — READ THIS BEFORE ANY V10 RETRAIN

**The training pipeline that produced the live model was never committed to this
repo and was partially lost.** Anyone retraining starts from a partial
reconstruction, not a clean checkout. This section is the map. (Established
2026-07-08 while fixing the 169-vs-212 feature drift; verify current state before
relying on it.)

### 7a. What was lost, and why

The **212-wide sequence builder** and the **trainer** were never version-controlled
in `corps-place`. The bulk `689fa05 "Restore full project tree"` commits
*clobbered* the working-tree copies with an older **169-wide** builder (the same
commit that swept in the stale/corrupt VA reference-curve column). Git history is
intact — the real files were simply never committed, so there's nothing to
`git revert` to. What survived untouched: the **inference** path
(`v9PredictionFeatures.ts`, `predictEventRecap.ts`) — inference was never lost.

### 7b. Where the recovered code lives

Recovered to a separate GitHub repo: **`doeixd/recovered-ml-212`**.
- **Builder — recovered and DB-validated.** Ran it → temp table, diffed vs the
  stored `ml_sequence_rows_v9_subcaption`: with the recovered **v4.1 reference
  curves** (`1a2af7ef`, 1575 keys) the **rankBaseline (121–128) and fingerprint
  (179–211) blocks are byte-exact**, cold-start ~99% exact → the builder logic is
  proven correct. It's since been ported into this repo as
  `sdk/src/buildMlSequencesV9Subcaption.ts` (the 212 version; see the drift memory
  / commits around `46ed382`).
- **Trainer — best-effort only.** Recovered with **~73 drifted hunks in the
  harness logic**. It has NOT been validated end-to-end. **Treat the trainer as
  the weakest link: reconstruct and verify it before trusting a retrain.**

### 7c. The Effect version gotcha

The recovered builder/trainer are **Effect v3** (`@effect/sql`); this repo is
**Effect v4** (`effect/unstable/sql`). Porting is mechanical but pervasive:
`function* (_)` → `function* ()`, `yield* _(` → `yield* (`, and the SQL import
paths. Do the port before running anything from the recovered repo.

### 7d. The index maps — why the recovered builder doesn't byte-match *everything*

The remaining ~3–9% drift (in the rank / elo / subcaption columns only) traces to
the **lost index maps** plus evolved elo/score data. The live `final2` model was
trained against specific maps:
- `judgeIndexMap` hash **`1c95f700`**
- `corpsIndexMap` hash **`99de63cc`**

The working-tree maps differ. **For V10 this is not a blocker** — a from-scratch
retrain generates its *own* fresh index maps and trains the embeddings against
them, so you don't need `final2`'s maps. But it's why you can't perfectly
reproduce `final2`'s exact training inputs from the current tree, and it's why the
recovered-builder validation shows small drift outside the two byte-exact blocks.
**Never regenerate these maps for *inference* against the current model** (see
§6d) — that rule is only lifted when you retrain and ship a matched new model.

### 7e. Checklist to actually retrain (V10)

1. **Port** the recovered builder + trainer from `doeixd/recovered-ml-212` to
   Effect v4 (§7c). Reconstruct/verify the trainer (§7b).
2. **Clean the training source.** Point the subcaption builder at the clean domain
   view / a de-contaminated `caption_scores` (§6c) — V9 trained on the raw
   contaminated table; this is the biggest free hardening.
3. **Add the new features** (P1 field-slope, schedule-anchored per §6e) and the
   **thin-history augmentation** (P2) — the two changes with the most leverage.
4. **Generate fresh index maps** for the new model (§7d); do not reuse `final2`'s.
5. **Rebuild** `ml_sequence_rows_v9_subcaption` (2013–present) with the corrected
   builder; confirm all rows are **212-wide** and the parity guards
   (`v9FeatureParity`, `v9InferenceParity`, `referenceCurveIntegrity`) pass.
6. **Validate** with the frozen-cutoff backtest AND a 2026 walk-forward, checking
   no regression on the data-rich majority (§4). Watch the P2 *ensemble* MAE, not
   `target` mode alone (§6a).
7. **Ship** a matched (model + index maps + curves) set together; then start
   deleting from the calibration-layer retire tracker (§5).
