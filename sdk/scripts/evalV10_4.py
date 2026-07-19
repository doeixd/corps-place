#!/usr/bin/env python3
"""v10.4 eval: does the SPREAD-PRESERVING / HIGH-END-AWARE LOSS kill the range-compression
under-prediction WITHOUT hurting ranking or the data-rich majority?

Extends the v10.3 4-way harness (identical honest holdout 2026-07-12 .. 07-16) with the
THREE success metrics from docs/V10_4_DESIGN.md sec.4 that MAE alone hides:
  - SIGNED total bias            -> target ~0   (was ~-0.86 on this slice)
  - DECOMPRESSION SLOPE          -> target ~0   (OLS slope of per-corps error on actual score;
                                                 was strongly NEGATIVE = top missed most)
  - SPREAD RATIO std(pred)/std(actual) -> target ~1 (per-show field spread; was <1 = compressed)
  - per-show SPEARMAN            -> must stay >=0.98 (ranking must not regress)
plus a field-position slice (top/mid/bottom tercile within each show) proving the miss shrinks
at the TOP specifically.

Models compared (each its OWN saved target-norm + ml-table, identity-agnostic control lane):
  V10   (2013-2025, no 2026)                 prefix "V10"    seeds 42-49  clean_control
  v10.1 (+2026 <=07-06)                       prefix "v10_1"  seeds 42-44  clean_control
  v10.2 (+2026 <=07-11)                       prefix "v10_2"  seeds 42-49  clean_control
  v10.3 (+2026 <=07-11, field-pace + P2)      prefix "v10_3"  seeds 42-44  field_pace   (3 seeds; box rebooted mid-run)
  v10.4 (v10.3 data/features + C1 LOSS: high-end 2.0 + asym 0.75)  prefix "v10_4"  seeds 42-49  field_pace  <-- the change
  v10.4b (high-end 2.0 ONLY, ablation)                            prefix "v10_4b" seeds 42-44  field_pace

Two clean isolations are printed:
  (A) v10.3 vs v10.4[42-44]   -- SAME data/features/seeds, differs ONLY in the loss -> pure C1 effect.
  (B) v10.4b vs v10.4[42-44]  -- attributes high-end-weight alone vs adding asym-tau (the shipped combined loss).
"""
import json, csv, statistics, glob, sys, os, math

COHORT_CSV = "results/v10_4_eval/holdout_cohort.csv"
EVAL_DIR = "results/v10_4_eval"
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

def group_files(prefix, seeds=None):
    fs = sorted(glob.glob(f"{EVAL_DIR}/{prefix}-*-holdout.json"))
    if seeds is not None:
        fs = [f for f in fs if any(f"-s{s}-" in os.path.basename(f) for s in seeds)]
    return fs

def ensemble_preds(files):
    models = [load(f) for f in files]
    keys = set(cohort)
    for P, _, _ in models:
        keys &= set(P)
    keys = sorted(keys)
    ens = {k: [statistics.mean(P[k][i] for P, _, _ in models) for i in range(8)] for k in keys}
    A0 = models[0][1]
    H0 = models[0][2]
    return ens, A0, H0, keys

# ---------- scalar metrics ----------
def recap_mae(pred, A, keys):
    return statistics.mean(abs(pred[k][i] - A[k][i]) for k in keys for i in range(8))

def total_mae(pred, keys):
    return statistics.mean(abs(derived(pred[k]) - cohort[k]["y_total"]) for k in keys)

def total_bias(pred, keys):  # SIGNED predicted-minus-actual (negative = UNDER-predict)
    return statistics.mean(derived(pred[k]) - cohort[k]["y_total"] for k in keys)

def debiased_mae(pred, keys):  # MAE after removing the mean signed bias (spread-only error)
    b = total_bias(pred, keys)
    return statistics.mean(abs((derived(pred[k]) - cohort[k]["y_total"]) - b) for k in keys)

def decompression_slope(pred, keys):
    """OLS slope of per-corps error (pred-actual) on actual total, pooled over the holdout.
    Compression => negative (bigger under-miss at high actual). Target ~0."""
    xs = [cohort[k]["y_total"] for k in keys]
    ys = [derived(pred[k]) - cohort[k]["y_total"] for k in keys]
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    var = sum((x-mx)**2 for x in xs)
    if var == 0: return float("nan")
    return sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / var

def _by_show(keys):
    shows = {}
    for k in keys:
        shows.setdefault(cohort[k]["slug"], []).append(k)
    return shows

def spread_ratio(pred, keys, min_field=3):
    """Mean over shows of std(pred_total)/std(actual_total) within the field. Target ~1."""
    ratios = []
    for s, ks in _by_show(keys).items():
        if len(ks) < min_field: continue
        pa = [derived(pred[k]) for k in ks]
        aa = [cohort[k]["y_total"] for k in ks]
        sa = statistics.pstdev(aa)
        if sa < 1e-9: continue
        ratios.append(statistics.pstdev(pa) / sa)
    return statistics.mean(ratios) if ratios else float("nan")

def _spearman(a, b):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0]*len(v); i = 0
        while i < len(v):
            j = i
            while j+1 < len(v) and v[order[j+1]] == v[order[i]]: j += 1
            avg = (i+j)/2.0 + 1
            for t in range(i, j+1): r[order[t]] = avg
            i = j+1
        return r
    ra, rb = ranks(a), ranks(b)
    n = len(a); mra = sum(ra)/n; mrb = sum(rb)/n
    num = sum((x-mra)*(y-mrb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x-mra)**2 for x in ra) * sum((y-mrb)**2 for y in rb))
    return num/den if den > 0 else float("nan")

def mean_spearman(pred, keys, min_field=3):
    rhos = []
    for s, ks in _by_show(keys).items():
        if len(ks) < min_field: continue
        rhos.append(_spearman([derived(pred[k]) for k in ks], [cohort[k]["y_total"] for k in ks]))
    rhos = [r for r in rhos if not math.isnan(r)]
    return statistics.mean(rhos) if rhos else float("nan")

def field_position_slices(pred, keys):
    """Within each show, tercile corps by ACTUAL (top/mid/bottom third); pool per slice.
    Returns {slice: (n, mae, bias)}. The core check: top-slice bias -> 0 in v10.4."""
    buckets = {"top": [], "mid": [], "bottom": []}
    for s, ks in _by_show(keys).items():
        ks_sorted = sorted(ks, key=lambda k: cohort[k]["y_total"], reverse=True)
        n = len(ks_sorted); t = max(1, n // 3)
        for i, k in enumerate(ks_sorted):
            b = "top" if i < t else ("bottom" if i >= n - t else "mid")
            buckets[b].append(k)
    out = {}
    for b, ks in buckets.items():
        if ks:
            out[b] = (len(ks), total_mae(pred, ks), total_bias(pred, ks))
    return out

def subset(keys, f):
    return [k for k in keys if f(k)]

def metrics_line(pred, A, keys):
    return (f"recap {recap_mae(pred,A,keys):.4f}  total {total_mae(pred,keys):.4f}  "
            f"bias {total_bias(pred,keys):+.4f}  debMAE {debiased_mae(pred,keys):.4f}  "
            f"slope {decompression_slope(pred,keys):+.4f}  spread {spread_ratio(pred,keys):.3f}  "
            f"rho {mean_spearman(pred,keys):.4f}")

def report_group(label, prefix, seeds=None):
    files = group_files(prefix, seeds)
    if not files:
        print(f"[{label}] no result files ({prefix}-*-holdout.json)")
        return None
    print(f"\n=== {label} ({len(files)} seeds) ===")
    for f in files:
        P, A, H = load(f)
        ks = [k for k in cohort if k in P]
        name = os.path.basename(f).replace("-holdout.json", "")
        print(f"  {name:34s} recap {recap_mae(P,A,ks):.4f}  total {total_mae(P,ks):.4f}  bias {total_bias(P,ks):+.4f}")
    ens, A, H, keys = ensemble_preds(files)
    print(f"  ENSEMBLE({len(files)})  {metrics_line(ens,A,keys)}  (rows {len(keys)})")
    print("  field position (tercile by actual within show):")
    for b, (n, mae, bias) in field_position_slices(ens, keys).items():
        print(f"    {b:7s} n={n:3d} total {mae:.4f} bias {bias:+.4f}")
    print("  by division:")
    for dv in ["World Class", "Open Class"]:
        dk = subset(keys, lambda k: cohort[k]["division"] == dv)
        if dk:
            print(f"    {dv:12s} n={len(dk):3d} total {total_mae(ens,dk):.4f} bias {total_bias(ens,dk):+.4f} "
                  f"slope {decompression_slope(ens,dk):+.4f} spread {spread_ratio(ens,dk):.3f}")
    return ens, A, keys

def boot_delta_ci(ensA, ensB, keys, metric):
    import random as _r
    rng = _r.Random(SEED)
    shows = sorted(set(cohort[k]["slug"] for k in keys))
    by_show = {s: [k for k in keys if cohort[k]["slug"] == s] for s in shows}
    deltas = []
    for _ in range(BOOT):
        samp = [k for s in (rng.choice(shows) for _ in shows) for k in by_show[s]]
        deltas.append(metric(ensB, samp) - metric(ensA, samp))
    deltas.sort()
    return (deltas[int(0.025*len(deltas))], deltas[int(0.975*len(deltas))],
            statistics.mean(deltas), sum(1 for d in deltas if d < 0)/len(deltas))

def pair(label, ensA, ensB, keys):
    print(f"\n--- {label} (identical {len(keys)} rows) ---")
    print(f"  {'A':>10s}: {metrics_line(ensA, None, keys)}".replace("recap nan  ", ""))
    print(f"  {'B':>10s}: {metrics_line(ensB, None, keys)}".replace("recap nan  ", ""))
    ba, bb = total_bias(ensA, keys), total_bias(ensB, keys)
    print(f"  signed bias {ba:+.4f} -> {bb:+.4f}   |bias| {abs(ba):.4f} -> {abs(bb):.4f}")
    sa, sb = decompression_slope(ensA, keys), decompression_slope(ensB, keys)
    print(f"  decompression slope {sa:+.4f} -> {sb:+.4f}  (target ~0)")
    ra, rb = spread_ratio(ensA, keys), spread_ratio(ensB, keys)
    print(f"  spread ratio {ra:.3f} -> {rb:.3f}  (target ~1)")
    lo, hi, mean, pneg = boot_delta_ci(ensA, ensB, keys, total_mae)
    print(f"  total-MAE DELTA {mean:+.4f} 95% CI [{lo:+.4f},{hi:+.4f}]  P(B better)={pneg:.2f}")
    lo, hi, mean, pneg = boot_delta_ci(ensA, ensB, keys, lambda p,ks: abs(total_bias(p,ks)))
    print(f"  |bias| DELTA {mean:+.4f} 95% CI [{lo:+.4f},{hi:+.4f}]  P(B smaller |bias|)={pneg:.2f}")

if __name__ == "__main__":
    nshows = len(set(cohort[k]['slug'] for k in cohort))
    print(f"Held-out 2026 slice: {len(cohort)} rows / {nshows} shows (2026-07-12 .. 07-16). "
          f"Control lane, identity-agnostic. Each model uses its own saved target-norm + ml-table.")
    print("v10.4 = v10.3 data/features (field-pace + 2026<=07-11) + C1 spread-preserving/high-end-aware LOSS.")
    print("Metrics: bias->0, decompression slope->0, spread ratio->1, per-show rho>=0.98, no majority MAE regression.\n")
    v10 = report_group("V10 (2013-2025, no 2026)", "V10")
    v11 = report_group("v10.1 (+2026 <=07-06)", "v10_1")
    v12 = report_group("v10.2 (+2026 <=07-11)", "v10_2")
    v13 = report_group("v10.3 (field-pace + P2, MSE loss)", "v10_3")
    v14 = report_group("v10.4 SHIP (C1: high-end 2.0 + asym 0.70)", "v10_4")
    v14b = report_group("v10.4b (high-end 2.0 + asym 0.60, gentler)", "v10_4b")
    v14c = report_group("v10.4c (high-end 2.0 only, tau=0.5)", "v10_4c")
    v14_3 = None
    if group_files("v10_4", seeds=[42,43,44]):
        v14_3 = report_group("v10.4 [seeds 42-44] (isolation vs v10.3)", "v10_4", seeds=[42,43,44])

    groups = [("V10",v10),("v10.1",v11),("v10.2",v12),("v10.3",v13),("v10.4",v14)]
    groups = [(n,g) for n,g in groups if g]
    if len(groups) >= 2:
        keys = sorted(set.intersection(*[set(g[2]) for _, g in groups]))
        print(f"\n=== N-WAY PAIRED ENSEMBLE (identical {len(keys)} common rows) ===")
        print(f"  {'model':7s} {'total':>7s} {'bias':>8s} {'debMAE':>7s} {'slope':>8s} {'spread':>7s} {'rho':>7s}")
        for name, (ens, A, _) in groups:
            print(f"  {name:7s} {total_mae(ens,keys):7.4f} {total_bias(ens,keys):+8.4f} "
                  f"{debiased_mae(ens,keys):7.4f} {decompression_slope(ens,keys):+8.4f} "
                  f"{spread_ratio(ens,keys):7.3f} {mean_spearman(ens,keys):7.4f}")

    # clean isolations
    if v13 and v14_3:
        keys = sorted(set(v13[2]) & set(v14_3[2]))
        pair("ISOLATION A: v10.3 (MSE) -> v10.4[42-44] (C1 loss) [same data/features/seeds]",
             v13[0], v14_3[0], keys)
    if v14c and group_files("v10_4", seeds=[42,43]):
        v14_2 = ensemble_preds(group_files("v10_4", seeds=[42,43]))
        keys = sorted(set(v14c[2]) & set(v14_2[3]))
        pair("ISOLATION B: v10.4c (pure high-end, tau=0.5) -> v10.4[42-43] (+asym 0.70) [asym sweep]",
             v14c[0], {k: v14_2[0][k] for k in v14_2[3]}, keys)
    if v10 and v14:
        keys = sorted(set(v10[2]) & set(v14[2]))
        pair("HEADLINE: V10 -> v10.4 (8-seed ensembles)", v10[0], v14[0], keys)
    if v12 and v14:
        keys = sorted(set(v12[2]) & set(v14[2]))
        pair("v10.2 -> v10.4 (8-seed ensembles)", v12[0], v14[0], keys)
