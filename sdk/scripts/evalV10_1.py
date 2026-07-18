#!/usr/bin/env python3
"""Paired v10.1-vs-V10 evaluation on the honest held-out 2026 slice.

Reads per-model replay JSONs (raw.history_details: per-row predicted_recap p50s +
actual_recap, keyed by (competition_slug, corps_key)) for two model groups, and
reports agnostic-ensemble recap/total MAE overall, by history bucket, by division,
per-seed paired diffs, and show-clustered bootstrap CIs (incl. on the v10.1-V10
delta). Ensemble = average the 8 caption p50s across seeds, then derive total.
"""
import json, csv, statistics, glob, sys, os

COHORT_CSV = "results/v10_1_eval/holdout_cohort.csv"
EVAL_DIR = "results/v10_1_eval"
BOOT = 2000
SEED = 12345
FINAL2 = "final2 (agnostic, full-161 ref): recap 0.4930 total 1.5141"

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

def subset(keys, pred_key):
    return [k for k in keys if pred_key(k)]

def report_group(label, prefix):
    files = group_files(prefix)
    if not files:
        print(f"[{label}] no result files ({prefix}-*-holdout.json)")
        return None
    print(f"\n=== {label} ({len(files)} seeds) ===")
    # per-seed
    per_seed = {}
    for f in files:
        P, A, H = load(f)
        ks = [k for k in cohort if k in P]
        per_seed[f] = (recap_mae(P, A, ks), total_mae(P, ks))
        name = os.path.basename(f).replace("-holdout.json", "")
        print(f"  {name:38s} recap {per_seed[f][0]:.4f}  total {per_seed[f][1]:.4f}")
    ens, A, H, keys = ensemble_preds(files)
    print(f"  {'ENSEMBLE ('+str(len(files))+' seeds)':38s} recap {recap_mae(ens,A,keys):.4f}  total {total_mae(ens,keys):.4f}  (rows {len(keys)})")
    # by history bucket
    print("  by history bucket:")
    for b in ["zero_history", "sparse_history", "short_history", "established_history"]:
        bk = subset(keys, lambda k: H[k] == b)
        if bk:
            print(f"    {b:20s} n={len(bk):3d} recap {recap_mae(ens,A,bk):.4f} total {total_mae(ens,bk):.4f}")
    # by division
    print("  by division:")
    for dv in ["World Class", "Open Class"]:
        dk = subset(keys, lambda k: cohort[k]["division"] == dv)
        if dk:
            print(f"    {dv:20s} n={len(dk):3d} recap {recap_mae(ens,A,dk):.4f} total {total_mae(ens,dk):.4f}")
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
    """Show-clustered CI on metric(B) - metric(A) (paired by show resample)."""
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

if __name__ == "__main__":
    print(f"Held-out 2026 slice: {len(cohort)} rows / "
          f"{len(set(cohort[k]['slug'] for k in cohort))} shows "
          f"(2026-07-07 .. 07-16). {FINAL2}")
    # Matched 8-seed comparison
    v10 = report_group("V10 (2013-2025)", "V10")
    v11 = report_group("v10.1 (+2026 thru 07-06)", "v10_1")
    if v10 and v11:
        ensA, AA, keysA = v10
        ensB, AB, keysB = v11
        keys = sorted(set(keysA) & set(keysB))
        print("\n=== PAIRED (identical rows) ===")
        for name, m in [("recap", recap_mae), ("total", total_mae)]:
            a = m(ensA, AA, keys) if m is recap_mae else m(ensA, keys)
            b = m(ensB, AB, keys) if m is recap_mae else m(ensB, keys)
            print(f"  {name}: V10 {a:.4f} -> v10.1 {b:.4f}  delta {b-a:+.4f} ({100*(b-a)/a:+.1f}%)")
        rlo, rhi = boot_ci(ensA, AA, keys, recap_mae)
        print(f"  V10   recap 95% CI [{rlo:.4f}, {rhi:.4f}]")
        rlo, rhi = boot_ci(ensB, AB, keys, recap_mae)
        print(f"  v10.1 recap 95% CI [{rlo:.4f}, {rhi:.4f}]")
        lo, hi, mean, pneg = boot_delta_ci(ensA, AA, ensB, AB, keys, recap_mae)
        print(f"  recap DELTA (v10.1-V10) mean {mean:+.4f} 95% CI [{lo:+.4f}, {hi:+.4f}]  P(v10.1 better)={pneg:.2f}")
        lo, hi, mean, pneg = boot_delta_ci(ensA, None, ensB, None, keys,
                                           lambda p,_a,ks: total_mae(p,ks))
        print(f"  total DELTA (v10.1-V10) mean {mean:+.4f} 95% CI [{lo:+.4f}, {hi:+.4f}]  P(v10.1 better)={pneg:.2f}")
