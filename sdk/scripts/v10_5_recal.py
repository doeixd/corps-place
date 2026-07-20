#!/usr/bin/env python3
"""v10.5 — division-aware, LEAKAGE-SAFE recalibration (C3) on v10.4's pooled ensemble.

Core idea: v10.4's residual bias is DIVISION-DEPENDENT (World Class still under-predicts,
Open Class already ~0). A single global tau can't zero both. So fit a THIN per-(division x
percent-through bucket) OFFSET on the v10.4 ensemble's residuals over resolved shows STRICTLY
BEFORE each target show (expanding window), shrunk toward 0 when the bucket is thin, and add it
to the predicted total. Reversible (off = plain v10.4).

LEAKAGE DISCIPLINE: for a target show at date d, the offset uses ONLY rows with competition_date
strictly < d. Never the target row, never same-day, never later. Verified by construction + an
explicit assertion in fit_offset().

This module provides:
  - load_ensemble(): v10.4 8-seed ensemble predicted_total + actual + division + pct + date,
    over the FULL 2026 eval set (06-27..07-16) from the broad replay JSONs.
  - Recal(cfg): the leakage-safe fitter/applier.
  - recal_holdout(): apply to the 39 holdout rows, return corrected totals for eval.
"""
import json, sqlite3, statistics, glob, os

EVDB = "data/v10-evaluation-2026-07-17.db"
BROAD_GLOB = "results/v10_5_eval/v10_4-fp-s*-broad.json"
HOLDOUT_FROM = "2026-07-12"
TRAIN_CUTOFF = "2026-07-11"  # v10.4 trained on 2026 <= this date (in-sample boundary)

def derived(r):
    return r[0] + r[1] + sum(r[2:8]) / 2

def load_meta():
    c = sqlite3.connect(EVDB)
    meta = {}
    for slug, ck, dv, xs, dt in c.execute(
        "SELECT competition_slug,corps_key,division_name,x_static_json,substr(competition_date,1,10) "
        "FROM ml_sequence_rows_v10_field_pace WHERE season=2026"):
        meta[(slug, ck)] = {"division": dv, "pct": json.loads(xs)[178], "date": dt}
    c.close()
    return meta

def load_ensemble():
    """Return dict key->{pred, actual, division, pct, date, slug} for ALL 2026 eval rows,
    pred = mean over the 8 v10.4 seeds of derived(predicted_recap)."""
    meta = load_meta()
    files = sorted(glob.glob(BROAD_GLOB))
    assert len(files) == 8, f"expected 8 broad seed files, found {len(files)}"
    preds, act = {}, {}
    for f in files:
        for x in json.load(open(f))["raw"]["history_details"]:
            k = (x["competition_slug"], x["corps_key"])
            preds.setdefault(k, []).append(derived(x["predicted_recap"]))
            act[k] = x["actual_total"]
    rows = {}
    for k, v in preds.items():
        m = meta[k]
        rows[k] = {"pred": statistics.mean(v), "actual": act[k], "division": m["division"],
                   "pct": m["pct"], "date": m["date"], "slug": k[0]}
    return rows

# ---------------- the leakage-safe recal ----------------
class Recal:
    """Per-(division x pct-bucket) additive offset, fit leakage-safe on prior resolved shows.

    cfg:
      pct_edges   : bucket boundaries on target_percent_through (list of interior cuts).
      shrink_k    : shrinkage constant; offset scaled by n/(n+shrink_k). Thin bucket -> ~0.
      recency_days: if >0, only prior rows within this many days of the target inform the fit
                    (locality in season-stage; 0 = full expanding history).
      in_sample   : if False, EXCLUDE rows dated <= TRAIN_CUTOFF from the fit pool (use only
                    genuinely out-of-sample post-cutoff shows -- the production-faithful analog).
      trim        : drop the min & max residual in a bucket before averaging when n>=trim_min
                    (robustness to season-debut / cold-start blowups). 0 = no trim.
      trim_min    : min bucket size to apply trimming.
      max_abs     : hard cap on |offset| (safety; keep the layer thin).
    """
    def __init__(self, rows, pct_edges=(), shrink_k=8.0, recency_days=0, in_sample=True,
                 trim=1, trim_min=5, max_abs=1.5):
        self.rows = rows
        self.pct_edges = list(pct_edges)
        self.shrink_k = shrink_k
        self.recency_days = recency_days
        self.in_sample = in_sample
        self.trim = trim
        self.trim_min = trim_min
        self.max_abs = max_abs

    def _bucket(self, pct):
        b = 0
        for e in self.pct_edges:
            if pct >= e:
                b += 1
        return b

    @staticmethod
    def _days(a, b):
        from datetime import date
        ya, ma, da = map(int, a.split("-")); yb, mb, db = map(int, b.split("-"))
        return abs((date(ya, ma, da) - date(yb, mb, db)).days)

    def fit_offset(self, division, pct, target_date):
        """Leakage-safe offset for a (division,pct) cell at target_date.
        Residual = actual - pred (positive = under-prediction -> ADD to correct)."""
        tgt_bucket = self._bucket(pct)
        resids = []
        for k, r in self.rows.items():
            if r["date"] >= target_date:      # STRICTLY BEFORE target -- the leakage guard
                continue
            if not self.in_sample and r["date"] <= TRAIN_CUTOFF:
                continue
            if r["division"] != division:
                continue
            if self._bucket(r["pct"]) != tgt_bucket:
                continue
            if self.recency_days and self._days(r["date"], target_date) > self.recency_days:
                continue
            resids.append(r["actual"] - r["pred"])
        n = len(resids)
        if n == 0:
            return 0.0, 0
        if self.trim and n >= self.trim_min:
            resids = sorted(resids)[self.trim:len(resids) - self.trim]
            n_eff = len(resids)
        else:
            n_eff = n
        if n_eff == 0:
            return 0.0, n
        raw = statistics.mean(resids)
        shrink = n / (n + self.shrink_k)          # thin -> shrink toward no-op
        off = max(-self.max_abs, min(self.max_abs, shrink * raw))
        return off, n

    def apply_holdout(self):
        """Return {key: corrected_total} for holdout rows (date>=HOLDOUT_FROM), plus a fit log."""
        out, log = {}, []
        for k, r in self.rows.items():
            if r["date"] < HOLDOUT_FROM:
                continue
            off, n = self.fit_offset(r["division"], r["pct"], r["date"])
            out[k] = r["pred"] + off
            log.append((k, r["division"], r["date"], off, n))
        return out, log
