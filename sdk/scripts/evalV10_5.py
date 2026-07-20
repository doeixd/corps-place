#!/usr/bin/env python3
"""v10.5 eval: does the DIVISION-AWARE, LEAKAGE-SAFE recalibration (C3) zero the per-division
residual bias of v10.4 for BOTH World Class AND Open Class, WITHOUT overshoot, ranking loss, or
regressing the data-rich majority?

N-way on the identical 39-row holdout (2026-07-12 .. 07-16), SLICED BY DIVISION (the headline)
and by field-position tercile:
  V10  / v10.2 / v10.3 / v10.4          -- reused from results/v10_4_eval holdout JSONs
  v10.5-recal                            -- v10.4 8-seed ensemble total + leakage-safe offset

The recal is fit per (division x pct-bucket) on resolved shows STRICTLY BEFORE each target's
date (expanding window, recency-limited, shrunk toward 0 when thin). See scripts/v10_5_recal.py.
Reuses evalV10_4.py's validated metric definitions verbatim (same cohort, same derived()).

v10.5 predictions are encoded as [total,0,0,0,0,0,0,0] so evalV10_4's derived()-based metrics
apply unchanged (recap-level metrics are N/A: the recal is a total-level safety layer).
"""
import importlib.util, statistics, sys, os

def _imp(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m); return m

HERE = os.path.dirname(os.path.abspath(__file__))
e4 = _imp("evalV10_4", os.path.join(HERE, "evalV10_4.py"))
rc = _imp("v10_5_recal", os.path.join(HERE, "v10_5_recal.py"))

cohort = e4.cohort
# metric fns (operate on pred-map of 8-vectors keyed by (slug,corps_key) + a key list)
total_mae, total_bias, debiased_mae = e4.total_mae, e4.total_bias, e4.debiased_mae
decompression_slope, spread_ratio, mean_spearman = e4.decompression_slope, e4.spread_ratio, e4.mean_spearman
field_position_slices, subset = e4.field_position_slices, e4.subset

def as_total_map(total_by_key):
    return {k: [t, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] for k, t in total_by_key.items()}

def ens_total_map(prefix, seeds=None):
    files = e4.group_files(prefix, seeds)
    if not files: return None, None
    ens, A, H, keys = e4.ensemble_preds(files)
    return ens, keys  # ens is already 8-vec map

def div_line(tag, pred, keys):
    out = [f"  {tag}"]
    for dv in ["World Class", "Open Class"]:
        dk = subset(keys, lambda k: cohort[k]["division"] == dv)
        if dk:
            out.append(f"    {dv:12s} n={len(dk):3d} bias {total_bias(pred,dk):+.4f} "
                       f"total {total_mae(pred,dk):.4f} slope {decompression_slope(pred,dk):+.4f} "
                       f"spread {spread_ratio(pred,dk):.3f}")
    return "\n".join(out)

def full_line(pred, keys):
    return (f"bias {total_bias(pred,keys):+.4f}  total {total_mae(pred,keys):.4f}  "
            f"debMAE {debiased_mae(pred,keys):.4f}  slope {decompression_slope(pred,keys):+.4f}  "
            f"spread {spread_ratio(pred,keys):.3f}  rho {mean_spearman(pred,keys):.4f}")

def main():
    P = print
    P("="*78)
    P("v10.5 EVAL — division-aware LEAKAGE-SAFE recalibration (C3) on v10.4's ensemble")
    P("="*78)
    nshows = len(set(cohort[k]['slug'] for k in cohort))
    P(f"Holdout: {len(cohort)} rows / {nshows} shows (2026-07-12..07-16). Control lane, "
      f"identity-agnostic, field-pace serve. Each pre-v10.4 model = its own saved norm/ml-table.")

    # ---- assemble models ----
    models = {}
    for name, prefix, seeds in [("V10","V10",None),("v10.2","v10_2",None),
                                 ("v10.3","v10_3",None),("v10.4","v10_4",None)]:
        ens, keys = ens_total_map(prefix, seeds)
        if ens: models[name] = (ens, keys)

    # v10.5 = recal on the v10.4 8-seed BROAD ensemble (identical holdout preds to v10.4)
    rows = rc.load_ensemble()
    hold_keys = sorted(k for k, r in rows.items() if r["date"] >= rc.HOLDOUT_FROM)
    v104_base = {k: rows[k]["pred"] for k in hold_keys}          # v10.4 ensemble totals
    recal = rc.Recal(rows, **RECAL_CFG)
    corrected, fitlog = recal.apply_holdout()
    v105 = {k: corrected[k] for k in hold_keys}

    # sanity: v10.4 broad ensemble must equal the v10.4 holdout-JSON ensemble (both use the
    # same models); assert the intersection bias matches so the comparison is honest.
    if "v10.4" in models:
        jk = sorted(set(models["v10.4"][1]) & set(hold_keys))
        b_json = total_bias(models["v10.4"][0], jk)
        b_broad = total_bias(as_total_map({k: v104_base[k] for k in jk}), jk)
        P(f"\n[consistency] v10.4 holdout bias  json={b_json:+.4f}  broad={b_broad:+.4f}  "
          f"delta={abs(b_json-b_broad):.4f} (must be ~0)")

    models["v10.4-broad"] = (as_total_map(v104_base), hold_keys)
    models["v10.5-recal"] = (as_total_map(v105), hold_keys)

    # ---- recal fit audit (leakage window) ----
    P("\n" + "-"*78)
    P("RECAL CONFIG: " + str(RECAL_CFG))
    P("Leakage-safe offsets applied to the holdout (fit on rows STRICTLY BEFORE target date):")
    seen = set()
    for k, dv, dt, off, n in sorted(fitlog, key=lambda x: (x[2], x[1])):
        if (dt, dv) in seen: continue
        seen.add((dt, dv))
        P(f"    target {dt}  {dv:11s}  offset {off:+.4f}   (fit n={n} prior-date rows)")

    # ---- N-way headline table (per division) ----
    common = sorted(set.intersection(*[set(k) for _, k in models.values()]))
    P("\n" + "="*78)
    P(f"N-WAY PER-DIVISION BIAS (identical {len(common)} common rows) — THE HEADLINE")
    P("="*78)
    P(f"  {'model':13s} {'ALL bias':>9s} {'WC bias':>9s} {'OC bias':>9s} {'ALL MAE':>8s} {'rho':>7s}")
    WC = subset(common, lambda k: cohort[k]["division"] == "World Class")
    OC = subset(common, lambda k: cohort[k]["division"] == "Open Class")
    order = ["V10","v10.2","v10.3","v10.4","v10.5-recal"]
    for name in order:
        if name not in models: continue
        pred, _ = models[name]
        P(f"  {name:13s} {total_bias(pred,common):+9.4f} {total_bias(pred,WC):+9.4f} "
          f"{total_bias(pred,OC):+9.4f} {total_mae(pred,common):8.4f} {mean_spearman(pred,common):7.4f}")
    P(f"\n  (WC n={len(WC)}, OC n={len(OC)})  TARGET: both WC and OC bias -> ~0, no overshoot,")
    P(f"  rho>=0.98, global |bias| < v10.4's.")

    # ---- v10.4 -> v10.5 detail ----
    P("\n" + "-"*78)
    P("v10.4  ->  v10.5-recal  (the recal effect, identical rows)")
    P("-"*78)
    for tag, pred in [("v10.4     ", models["v10.4-broad"][0]), ("v10.5-recal", models["v10.5-recal"][0])]:
        P(f"  {tag}: {full_line(pred, hold_keys)}")
        P(div_line("by division:", pred, hold_keys))
        fps = field_position_slices(pred, hold_keys)
        P("    tercile: " + "  ".join(f"{b} bias {v[2]:+.3f}(n{v[0]})" for b, v in fps.items()))

    # ---- full N-way with all metrics ----
    P("\n" + "="*78)
    P(f"N-WAY FULL METRICS (identical {len(common)} common rows)")
    P("="*78)
    P(f"  {'model':13s} {'bias':>8s} {'total':>7s} {'debMAE':>7s} {'slope':>8s} {'spread':>7s} {'rho':>7s}")
    for name in order:
        if name not in models: continue
        pred, _ = models[name]
        P(f"  {name:13s} {total_bias(pred,common):+8.4f} {total_mae(pred,common):7.4f} "
          f"{debiased_mae(pred,common):7.4f} {decompression_slope(pred,common):+8.4f} "
          f"{spread_ratio(pred,common):7.3f} {mean_spearman(pred,common):7.4f}")

    # ---- ranking-safety proof + significance (v10.4 -> v10.5) ----
    p4, p5 = models["v10.4-broad"][0], models["v10.5-recal"][0]
    P("\n" + "-"*78)
    P("RANKING SAFETY (per-show Spearman, high precision; 4/6 holdout shows are mixed-division)")
    P(f"  v10.4 rho={mean_spearman(p4,hold_keys):.6f}   v10.5 rho={mean_spearman(p5,hold_keys):.6f}"
      f"   delta={mean_spearman(p5,hold_keys)-mean_spearman(p4,hold_keys):+.6f}")

    def boot(metric, subkeys, B=2000, seed=12345):
        import random
        rng = random.Random(seed)
        shows = sorted(set(cohort[k]["slug"] for k in subkeys))
        byshow = {s: [k for k in subkeys if cohort[k]["slug"] == s] for s in shows}
        d = []
        for _ in range(B):
            samp = [k for s in (rng.choice(shows) for _ in shows) for k in byshow[s]]
            d.append(metric(p5, samp) - metric(p4, samp))
        d.sort()
        return d[int(0.025*B)], d[int(0.975*B)], statistics.mean(d), sum(1 for x in d if x < 0)/B
    P("\nSIGNIFICANCE (v10.5 - v10.4, show-bootstrap 2000x):")
    for lab, metric, sub in [("|WC bias|", lambda p,ks: abs(total_bias(p,ks)), WC),
                              ("|OC bias|", lambda p,ks: abs(total_bias(p,ks)), OC),
                              ("|global bias|", lambda p,ks: abs(total_bias(p,ks)), common),
                              ("total MAE", total_mae, common)]:
        lo, hi, mean, pneg = boot(metric, sub)
        P(f"  {lab:14s} delta {mean:+.4f}  95%CI [{lo:+.4f},{hi:+.4f}]  P(v10.5 lower)={pneg:.2f}")

    return models, common

# leakage-safe recal config chosen from the sweep (thin, recency-local, shrunk):
RECAL_CFG = dict(pct_edges=(), shrink_k=8.0, recency_days=14, in_sample=True,
                 trim=1, trim_min=5, max_abs=1.5)

if __name__ == "__main__":
    main()
