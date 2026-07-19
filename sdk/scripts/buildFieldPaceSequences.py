#!/usr/bin/env python3
"""Build ml_sequence_rows_v10_field_pace by APPENDING the 4 field-pace tail features
to an existing ml_sequence_rows_v10_clean_control table in the same DB.

WHY THIS IS FAITHFUL TO THE REAL BUILDER (not a shortcut hack):
  The real `buildMlSequencesV9Subcaption.ts --feature-profile field-pace` builds x_static
  IDENTICALLY to clean-control for the base 212 dims, then appends 4 features read from
  v10_temporal_field_pace (buildMlSequencesV9Subcaption.ts:1944-1956):
      [ field_level_vs_reference/10, shrunk_residual_slope/10, residual_ema/10, confidence ]
  keyed by row_key = "season|slug|division|corps_key" (v10RowKey, :869). The base-212
  construction is shared and profile-independent. Proven byte-exact on data/v10-field-dev1.db
  (which contains BOTH tables): base_mismatch=0, tail_mismatch=0 over 7317 rows.
  The temporal block is built strict-date-before-target (leakage-safe; field_leaks=0 in the
  frozen eval contract), so appending it introduces no leakage.

  The real builder THROWS on any target row missing its temporal field-pace match
  (:1946-1948). We assert the same: 100% coverage or we abort. It also requires static
  length == raw-static-dim (trainer silently DROPS rows where len != 216, trainModelV95.ts:1297),
  so we assert every output row is exactly 216-wide.

Usage:
  python3 scripts/buildFieldPaceSequences.py --db <db> [--builder-version <tag>]
Idempotent: drops+recreates ml_sequence_rows_v10_field_pace in the target DB.
"""
import argparse, json, sqlite3, sys

CTRL = "ml_sequence_rows_v10_clean_control"
FP = "ml_sequence_rows_v10_field_pace"
BASE_DIM = 212
OUT_DIM = 216

ap = argparse.ArgumentParser()
ap.add_argument("--db", required=True)
ap.add_argument("--builder-version", default="v10-field-pace-dev6-append-2026-07-19")
args = ap.parse_args()

db = sqlite3.connect(args.db)
db.execute("PRAGMA foreign_keys=OFF")

# --- load leakage-safe temporal field-pace, keyed by row_key ---
tf = {}
for rk, lvl, slope, ema, conf in db.execute(
    "SELECT row_key, field_level_vs_reference, shrunk_residual_slope, residual_ema, confidence "
    "FROM v10_temporal_field_pace"):
    tf[rk] = (lvl, slope, ema, conf)
print(f"[fieldpace] loaded {len(tf)} v10_temporal_field_pace keys", file=sys.stderr)

# --- recreate target table with identical schema to clean_control ---
ctrl_sql = db.execute(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (CTRL,)).fetchone()
if not ctrl_sql:
    sys.exit(f"ERROR: {CTRL} not found in {args.db}")
db.execute(f"DROP TABLE IF EXISTS {FP}")
db.execute(ctrl_sql[0].replace(CTRL, FP, 1))

cols = ("season,competition_slug,competition_date,division_name,corps_key,corps_id,"
        "x_sequence_json,x_static_json,judge_indices_json,y_residuals_json,y_recap_json,"
        "y_total,agnostic_show_id,builder_version,reference_curves_version,map_version,"
        "split,created_at")
collist = cols.split(",")
i_static = collist.index("x_static_json")
i_builder = collist.index("builder_version")

rows_out = []
missing = 0
badbase = 0
baddim = 0
nonzero = 0
for r in db.execute(f"SELECT {cols} FROM {CTRL}"):
    r = list(r)
    season, slug, div, corps = r[0], r[1], r[3], r[4]
    rk = f"{season}|{slug}|{div}|{corps}"
    t = tf.get(rk)
    if t is None:
        missing += 1
        continue
    stat = json.loads(r[i_static])
    if len(stat) != BASE_DIM:
        badbase += 1
        continue
    tail = [t[0] / 10.0, t[1] / 10.0, t[2] / 10.0, t[3]]
    stat = stat + tail
    if len(stat) != OUT_DIM:
        baddim += 1
        continue
    if any(abs(v) > 1e-12 for v in tail):
        nonzero += 1
    r[i_static] = json.dumps(stat)
    r[i_builder] = args.builder_version
    rows_out.append(r)

if missing:
    sys.exit(f"ERROR: {missing} clean_control rows missing a temporal field-pace match "
             f"(real builder would throw). Aborting.")
if badbase or baddim:
    sys.exit(f"ERROR: base-dim!=212 ({badbase}) or out-dim!=216 ({baddim}). Aborting.")

db.executemany(
    f"INSERT INTO {FP} ({cols}) VALUES ({','.join('?' * len(collist))})", rows_out)
db.commit()

# --- structural verification (subset of testV10FieldPace's contract) ---
n = db.execute(f"SELECT COUNT(*) FROM {FP}").fetchone()[0]
nctrl = db.execute(f"SELECT COUNT(*) FROM {CTRL}").fetchone()[0]
# ÷10 parity re-check straight from the written table
parity_bad = 0
for season, slug, div, corps, sj in db.execute(
        f"SELECT season,competition_slug,division_name,corps_key,x_static_json FROM {FP}"):
    st = json.loads(sj)
    if len(st) != OUT_DIM:
        parity_bad += 1
        continue
    t = tf[f"{season}|{slug}|{div}|{corps}"]
    exp = [t[0] / 10.0, t[1] / 10.0, t[2] / 10.0, t[3]]
    if any(abs(a - b) > 1e-9 for a, b in zip(exp, st[BASE_DIM:OUT_DIM])):
        parity_bad += 1
print(f"[fieldpace] wrote {n} rows to {FP} (clean_control had {nctrl}); "
      f"{nonzero} rows have non-zero field-pace tail; parity_bad={parity_bad}", file=sys.stderr)
if n != nctrl:
    sys.exit(f"ERROR: field_pace row count {n} != clean_control {nctrl}")
if parity_bad:
    sys.exit(f"ERROR: {parity_bad} rows failed ÷10 tail parity or dim check")
if nonzero == 0:
    sys.exit("ERROR: all field-pace tails are zero (feature not populated)")
print(f"[fieldpace] OK: {FP} built and verified in {args.db}", file=sys.stderr)
