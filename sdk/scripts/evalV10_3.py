#!/usr/bin/env python3
"""4-way paired evaluation on the honest held-out 2026 slice (2026-07-12 .. 07-16).

Compares the agnostic control ensembles of:
  V10   (2013-2025, no 2026)                     -- prefix "V10"   seeds 42-49  (clean_control)
  v10.1 (+2026 thru 07-06)                        -- prefix "v10_1" seeds 42/43/44 (clean_control)
  v10.2 (+2026 thru 07-11)                        -- prefix "v10_2" seeds 42-49  (clean_control)
  v10.3 (+2026 thru 07-11, FIELD-PACE + P2 aug)   -- prefix "v10_3" seeds 42-49  (field_pace)
on the IDENTICAL 07-12..07-16 holdout. Each model's replay JSON was produced with its OWN
saved target-norm (--norm-path) and its OWN ml-table. Ensemble = average the 8 caption p50s
across seeds, then derive total. Reports per-seed + ensemble recap/total MAE, SIGNED total
bias (THE HEADLINE: does field-pace drive bias -> 0 vs V10/v10.2's ~-0.86?), by history
bucket + division, and show-clustered bootstrap CIs including on the v10.3-V10 and
v10.3-v10.2 deltas.
"""
import json, csv, statistics, glob, sys, os

COHORT_CSV = "results/v10_3_eval/holdout_cohort.csv"
EVAL_DIR = "results/v10_3_eval"
BOOT = 2000
SEED = 12345

def derived(r):  # fixed total-from-caption derivation used everywhere in V10
    return r[0] + r[1] + sum(r[2:8]) / 2

cohort = {}
for row in csv.DictReader(open(COHORT_CSV)):
    k = (row["competition_slug"], row["corps_key"])
    cohort[k] = {"y_total": float(row["y_total"]), "division": row["division_name"],
                 "date": row["competition_date"], "slug": row["competition_slug"]}

def load(path):
    d = json.load(open(path))["raw"]["history_details"]
    P = {(x["competition_slug"], x["corps_key"]): x["predicted_recap"] for x in d}
    A = {(x["competition_slug"], x["corps_key"]): x["actual_recap"] for x in d}
    H = {(x["competition_slug"], x["corps_key"]): x["history_bucket"] for x in d}
    return P, A, H

def group_files(prefix):
    return sorted(glob.glob(f"{EVAL_DIR}/{prefix}-*-holdout.json"))

def ensemble_preds(files):
    """Average p50s across seeds per key. Returns (ens_pred, actual, hist, keys)."""
    models = [load(f) for f in files]
    keys = set(cohort)
    for P, _, _ in models:
        keys &= set(P)
    keys = sorted(keys)
    ens = {k: [statistics.mean(P[k][i] for P, _, _ in models) for i in range(8)] for k in keys}
    A0 = models[0][1]
    H0 = models[0][2]
    return ens, A0, H0, keys

def recap_mae(pred, A, keys):
    return statistics.mean(abs(pred[k][i] - A[k][i]) for k in keys for i in range(8))

def total_mae(pred, keys):
    return statistics.mean(abs(derived(pred[k]) - cohort[k]["y_total"]) for k in keys)

def total_bias(pred, keys):  # SIGNED: predicted-minus-actual (positive = over-predict)
    return statistics.mean(derived(pred[k]) - cohort[k]["y_total"] for k in keys)

def subset(keys, pred_key):
    return [k for k in keys if pred_key(k)]

def report_group(label, prefix):
    files = group_files(prefix)
    if not files:
        print(f"[{label}] no result files ({prefix}-*-holdout.json)")
        return None
    print(f"\n=== {label} ({len(files)} seeds) ===")
    per_seed = {}
    for f in files:
        P, A, H = load(f)
        ks = [k for k in cohort if k in P]
        per_seed[f] = (recap_mae(P, A, ks), total_mae(P, ks), total_bias(P, ks))
        name = os.path.basename(f).replace("-holdout.json", "")
        print(f"  {name:34s} recap {per_seed[f][0]:.4f}  total {per_seed[f][1]:.4f}  bias {per_seed[f][2]:+.4f}")
    ens, A, H, keys = ensemble_preds(files)
    print(f"  {'ENSEMBLE ('+str(len(files))+' seeds)':34s} recap {recap_mae(ens,A,keys):.4f}  "
          f"total {total_mae(ens,keys):.4f}  bias {total_bias(ens,keys):+.4f}  (rows {len(keys)})")
    print("  by history bucket:")
    for b in ["zero_history", "sparse_history", "short_history", "established_history"]:
        bk = subset(keys, lambda k: H[k] == b)
        if bk:
            print(f"    {b:20s} n={len(bk):3d} recap {recap_mae(ens,A,bk):.4f} total {total_mae(ens,bk):.4f} bias {total_bias(ens,bk):+.4f}")
    print("  by division:")
    for dv in ["World Class", "Open Class"]:
        dk = subset(keys, lambda k: cohort[k]["division"] == dv)
        if dk:
            print(f"    {dv:20s} n={len(dk):3d} recap {recap_mae(ens,A,dk):.4f} total {total_mae(ens,dk):.4f} bias {total_bias(ens,dk):+.4f}")
    return ens, A, keys

def boot_ci(ens, A, keys, metric):
    import random as _r
    rng = _r.Random(SEED)
    shows = sorted(set(cohort[k]["slug"] for k in keys))
    by_show = {s: [k for k in keys if cohort[k]["slug"] == s] for s in shows}
    vals = []
    for _ in range(BOOT):
        samp = [k for s in (rng.choice(shows) for _ in shows) for k in by_show[s]]
        vals.append(metric(ens, A, samp))
    vals.sort()
    return vals[int(0.025*len(vals))], vals[int(0.975*len(vals))]

def boot_delta_ci(ensA, AA, ensB, AB, keys, metric):
    """Show-clustered CI on metric(B) - metric(A) (paired by show resample).
    Positive delta => B worse (higher error). P(B better) = fraction of deltas < 0."""
    import random as _r
    rng = _r.Random(SEED)
    shows = sorted(set(cohort[k]["slug"] for k in keys))
    by_show = {s: [k for k in keys if cohort[k]["slug"] == s] for s in shows}
    deltas = []
    for _ in range(BOOT):
        samp = [k for s in (rng.choice(shows) for _ in shows) for k in by_show[s]]
        deltas.append(metric(ensB, AB, samp) - metric(ensA, AA, samp))
    deltas.sort()
    return (deltas[int(0.025*len(deltas))], deltas[int(0.975*len(deltas))],
            statistics.mean(deltas), sum(1 for d in deltas if d < 0)/len(deltas))

def bias_abs_delta_ci(ensA, ensB, keys):
    """Show-clustered CI on |bias(B)| - |bias(A)| (does B have SMALLER magnitude bias?).
    Positive => B has larger |bias| (worse). P(B better) = fraction < 0."""
    import random as _r
    rng = _r.Random(SEED)
    shows = sorted(set(cohort[k]["slug"] for k in keys))
    by_show = {s: [k for k in keys if cohort[k]["slug"] == s] for s in shows}
    deltas = []
    for _ in range(BOOT):
        samp = [k for s in (rng.choice(shows) for _ in shows) for k in by_show[s]]
        deltas.append(abs(total_bias(ensB, samp)) - abs(total_bias(ensA, samp)))
    deltas.sort()
    return (deltas[int(0.025*len(deltas))], deltas[int(0.975*len(deltas))],
            statistics.mean(deltas), sum(1 for d in deltas if d < 0)/len(deltas))

def pair(label, A, B, keys):
    ensA, AA = A
    ensB, AB = B
    print(f"\n--- {label} (identical {len(keys)} rows) ---")
    for name, m in [("recap", recap_mae), ("total", total_mae)]:
        a = m(ensA, AA, keys) if m is recap_mae else m(ensA, keys)
        b = m(ensB, AB, keys) if m is recap_mae else m(ensB, keys)
        print(f"  {name}: {a:.4f} -> {b:.4f}  delta {b-a:+.4f} ({100*(b-a)/a:+.1f}%)")
    ba, bb = total_bias(ensA, keys), total_bias(ensB, keys)
    print(f"  signed total bias: {ba:+.4f} -> {bb:+.4f}   |bias|: {abs(ba):.4f} -> {abs(bb):.4f}")
    lo, hi, mean, pneg = boot_delta_ci(ensA, AA, ensB, AB, keys, recap_mae)
    print(f"  recap DELTA mean {mean:+.4f} 95% CI [{lo:+.4f}, {hi:+.4f}]  P(B better)={pneg:.2f}")
    lo, hi, mean, pneg = boot_delta_ci(ensA, None, ensB, None, keys,
                                       lambda p,_a,ks: total_mae(p,ks))
    print(f"  total DELTA mean {mean:+.4f} 95% CI [{lo:+.4f}, {hi:+.4f}]  P(B better)={pneg:.2f}")
    lo, hi, mean, pneg = bias_abs_delta_ci(ensA, ensB, keys)
    print(f"  |bias| DELTA mean {mean:+.4f} 95% CI [{lo:+.4f}, {hi:+.4f}]  P(B smaller |bias|)={pneg:.2f}")

if __name__ == "__main__":
    nshows = len(set(cohort[k]['slug'] for k in cohort))
    print(f"Held-out 2026 slice: {len(cohort)} rows / {nshows} shows (2026-07-12 .. 07-16). "
          f"Control lane, identity-agnostic. Each model uses its own saved target-norm + ml-table.")
    print("v10.3 = field-pace (P1) + thin-history truncation aug (P2) + 2026 data thru 07-11. "
          "P3 baseline-blend deferred (train/serve mismatch; see report).")
    v10 = report_group("V10 (2013-2025, no 2026)", "V10")
    v11 = report_group("v10.1 (+2026 thru 07-06)", "v10_1")
    v12 = report_group("v10.2 (+2026 thru 07-11)", "v10_2")
    v13 = report_group("v10.3 (+2026, FIELD-PACE + P2)", "v10_3")
    if v10 and v13:
        ens10, A10, k10 = v10
        ens12, A12, k12 = v12 if v12 else (None, None, set(k10))
        ens13, A13, k13 = v13
        keys = sorted(set(k10) & set(k13))
        rows = [("V10", ens10, A10)]
        if v11:
            ens11, A11, k11 = v11
            keys = sorted(set(keys) & set(k11))
            rows.append(("v10.1", ens11, A11))
        if v12:
            keys = sorted(set(keys) & set(k12))
            rows.append(("v10.2", ens12, A12))
        keys = sorted(set(keys) & set(k13))
        rows.append(("v10.3", ens13, A13))
        print("\n=== 4-WAY PAIRED (identical rows) ===")
        print(f"  ensemble on {len(keys)} common rows:")
        for name, ens, A in rows:
            print(f"    {name:6s} recap {recap_mae(ens,A,keys):.4f}  total {total_mae(ens,keys):.4f}  bias {total_bias(ens,keys):+.4f}")
        for name, ens, A in rows:
            lo, hi = boot_ci(ens, A, keys, recap_mae)
            print(f"    {name:6s} recap 95% CI [{lo:.4f}, {hi:.4f}]")
        pair("v10.3 vs V10", (ens10, A10), (ens13, A13), keys)
        if v12:
            pair("v10.3 vs v10.2", (ens12, A12), (ens13, A13), keys)
