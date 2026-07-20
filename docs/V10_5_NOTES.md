# V10.5 — Notes (potential next iteration)

**Status:** notes only, not scheduled. Authored 2026-07-19, off the v10.4 wave-1 result.
Builds on `V10_4_DESIGN.md`. Read that first — v10.5 is a *tuning* iteration of the same
range-compression fix, not a new direction.

## 1. Where the model line stands (progression)

| model | what it added | Southwestern as-of-07-17 (bias / MAE) | verdict |
|---|---|---|---|
| **V10** | baseline, 2013–2025, identity-agnostic | −1.72 / 1.79 | under-predicts, range-compressed |
| **v10.2** | +2026 data (≤07-11) | (holdout: −5.1% recap vs V10) | data helps; bias unchanged |
| **v10.3** | + field-pace feature (P1) | −1.81 / 1.83 | ranking↑, bias NOT fixed |
| **v10.4** | + spread/asym loss (C1) `hew 2.0, τ 0.70` | **−1.59 / 1.69** | **best yet; loss works but gentle** |

The under-prediction is a **range-compression artifact of MSE** (top-of-field missed most,
bottom ~0), NOT a missing feature — verified: all prior-season/trajectory features ARE fed;
only learned embeddings + judge_elo are masked. See `V10_4_DESIGN.md` §2.

## 2. The v10.4 finding that motivates v10.5

Isolating the loss (v10.3 → v10.4, same seeds 42-44, only the loss differs), the C1 spread
loss (`--high-end-weight 2.0 --asym-tau 0.70`) **worked but under-shot**:
- bias −1.81 → **−1.59** (closed only ~15–25% of the ~1.8 gap)
- MAE 1.83 → **1.69** (best of any model)
- top-of-field errors shrank: Bluecoats −3.33→−2.97, Blue Devils −4.83→−4.25, Boston −2.61→−2.02
- decompression slope −0.136 → −0.117, spread ratio 0.87 → 0.89 — **barely moved**
- **No overshoot** (bias stayed negative), ranking held/improved (Spearman 0.991, 12/22 exact)

**Key inference:** because it *under*-shoots (not overshoots), there's clear headroom to push
the loss harder. The 0.70/2.0 setting is safe but too weak to actually decompress the range.

## 2b. UPDATE (2026-07-20): v10.4 became a two-config τ SWEEP — recompute v10.5 from its points

v10.4's driver is running TWO loss configs, both `high-end-weight 2.0`, `spread-reg OFF`:
`v10_4` (`asym-tau 0.70`) + `v10_4b` (`asym-tau 0.60`). So v10.4 already **brackets the low end**
of the bias-vs-τ curve. Consequences for v10.5:
- **Don't re-test τ≤0.70** — v10.4 covers it. v10.5 starts ABOVE 0.70 (or pivots, below).
- **Use the two points (τ0.60, τ0.70) as a dose-response.** Extrapolate the τ that would reach
  bias≈0. CRITICAL CHECK: pinball τ must stay < 1.0. If the per-0.10-τ bias movement is small
  (e.g. ≲0.15), the τ implied to close the remaining ~1.5 is **> 1.0 = OUT OF RANGE** → asym-τ
  tuning ALONE is a dead end, and v10.5 must pivot to range/anchor/recal levers, NOT more τ.
- **`spread-reg` is still completely untested** (both v10.4 arms have it off). It's the lever most
  likely to move `spread`/`slope` (weighting only nudges the mean). This is v10.5's real new content.
- **Decision rule for v10.5 (set from `V10_4_EVAL_REPORT.txt`):**
  - τ has clear headroom in-range → v10.5 = higher τ (0.80–0.90) **+ spread-reg ON** (stacked).
  - τ saturates / bias=0 needs τ>1 → v10.5 = **spread-reg ON** + `--predict-absolute` diagnostic
    (is the last-recap anchor the floor?) + thin **C3 recalibration** to close the residual.
  Either way: **spread-reg goes ON in v10.5** — that's the untested lever. Compute the grid from
  v10.4's numbers; do not pre-guess τ.

## 2c. UPDATE (2026-07-20): v10.4 COMPLETE — holdout result reshapes v10.5

v10.4 finished. Holdout (07-12→07-16, 39 rows) N-way: **v10.4 total MAE 0.84 (best; V10 1.17),
bias −0.49 (V10 −0.88 — nearly halved), ranking 0.990 (best).** Clean progression V10 −0.88 →
v10.3 (field-pace) −0.69 → v10.4 (+loss) −0.49. Two findings that CHANGE the v10.5 plan:

1. **Spread/compression is NOT the holdout problem.** spread ratio ≈1.0 for ALL models near the
   cutoff (even V10 = 1.008), slope ≈−0.04 for all. The range-compression we saw on Southwestern
   is a **finals-week EXTRAPOLATION artifact**, not general. → **DE-PRIORITIZE `spread-reg`** for
   v10.5 (it targets a problem that only shows up far past the cutoff); the **August full-season
   retrain** (more top-of-range training targets) is the real fix for championship compression.
   The near-cutoff residual is pure **level/bias**, which the asym loss attacks directly.

2. **The residual bias is DIVISION-DEPENDENT — this is v10.5's real target.** At τ=0.7: World
   Class still −0.61 but Open Class already **+0.15 (OVERSHOOTING positive)**; one seed went
   +0.02 overall. τ dose-response (τ0.5→−0.75, τ0.7→−0.40) implies global bias≈0 near **τ≈0.90 —
   in range** — BUT a single global τ that zeroes WC will push OC further positive. → **v10.5 =
   DIVISION-AWARE correction, not higher global τ.** Options: division-conditioned loss weight /
   τ, or (cleaner) the **C3 per-(division × percent-through) recalibration** — which naturally
   handles the WC-vs-OC split and is cheap/reversible. This supersedes §2b's "just push τ".

**Revised v10.5 lead plan:** keep τ≈0.7–0.8 (near the global sweet spot), add a **division-aware
recalibration (C3)** as the primary new lever, and rely on the **August full-season data** for the
championship-extrapolation compression. `spread-reg` and higher global τ are now secondary.

## 3. v10.5 hypothesis + parameter directions

**Push the loss harder, and add an explicit spread term** (weighting alone nudges the mean;
it doesn't directly expand the range — hence slope/spread barely moved).

Sweep, ideally as parallel A/B configs (the trainer already has the flags):
- `--asym-tau` **0.80, 0.85, 0.90** (was 0.70) — stronger under-prediction penalty.
- `--high-end-weight` **3.0, 4.0** (was 2.0) — more emphasis on top-of-field rows.
- `--spread-reg` **λ > 0** (was unused) — the term that *directly* penalizes predicted-vs-actual
  field-std compression. This is the most likely lever to move `spread`/`slope`, which weighting
  alone didn't. **Prioritize turning this on** — v10.4 only used weighting + asymmetry.
- Consider a **listwise/rank-spread loss** on the total within each show (stretch the predicted
  ordering to match the actual spacing, not just the order).

Recommended first v10.5 grid (small, decisive): {τ0.85 × hew3 × spreadReg-on} as the lead
config, plus {τ0.90 × hew4 × spreadReg-on} as the aggressive arm, both vs the τ0.70 baseline.

## 4. Metrics + the overshoot guardrail (unchanged from V10_4 §4)
Success = **bias → 0 AND spread ratio → 1.0 AND decompression slope → 0**, WITHOUT:
- overshooting into **positive** bias (watch the sign as τ/hew climb — the whole point of the
  sweep is to find where bias crosses 0),
- inflating **de-biased MAE** or hurting the **data-rich mid/bottom** of the field,
- dropping **ranking** (Spearman ≥ 0.98).
Watch all four together — it's easy to kill bias by overshooting and call it a win.

## 5. What's settled — do NOT relitigate in v10.5
- **It's not a feature gap.** Don't add "prior-season comparable" features expecting a bias fix
  (the info is already fed). P3 anchor-blend stays deferred (targets thin-history, not this).
- **Keep field-pace (P1)** in — it helps ranking, it's cheap, and it's the current contract.
- **Keep +2026 data / full-season (C2)** — v10.2 proved it helps; v10.4 uses it.
- **Control lane only** (phase-aware-lr is buggy with date-gated training — v10.1).
- **Serve via `cleanV10ServeFP` (STATIC_DIM=216)** on the field-pace template; model static
  input = 224 (216 + 8 trend). Per-seed norm goes in-dir as `target-norm.json`.

## 6. Open questions / things to check with the full v10.4 run first
- **Does the gentle 0.70/2.0 improvement hold on the near-cutoff holdout (8 seeds)?** The
  Southwestern check is one show, 3 seeds, and a 7-day extrapolation past the training cutoff —
  the hardest case. The holdout (shows just after 07-11) may show a *larger* loss effect. READ
  `V10_4_EVAL_REPORT.txt` before committing to v10.5 settings.
- **Is the residual −1.59 partly the last-recap anchor**, not just MSE? If pushing the loss
  hits diminishing returns before bias→0, the anchor+MSE combo may be the floor → then the
  `--predict-absolute` diagnostic (V10_4 §3) or revisiting the anchor becomes the next lever.
- **Recalibration (C3/P5)** was deferred. If the loss sweep gets bias to ~−0.5 but not 0, a
  thin per-(division × percent-through) recal is the cheap closer — cheaper than chasing the
  last 0.5 pts through the loss and risking overshoot.
- **Championship extrapolation:** even a perfect mid-season model may under-shoot a finals-week
  jump 7+ days out. The August full-season retrain (more top-of-range training targets) is the
  structural fix for that, orthogonal to the loss.

## 7. Logistics (same as v10.2–v10.4)
Branch off v10.4; dev7 full-season contract; control seeds 42–49; self-running driver (train →
eval → REPORT → commit/push, no external watcher — the -p session exits); leakage discipline
(inputs strictly before target; don't regenerate frozen index maps). **Box constraint:** mini-PC
C: is tight and backs the WSL vhdx — only ONE 8-seed run fits; free C: (`powercfg /h off`, temp)
before launching. See memory `mini-pc-disk-full-wedge`.
