#!/usr/bin/env python3
# Evaluate the V10 shadow: for every shadow forecast whose event has SINCE been scored,
# compare V10-shadow vs final2 (from prod) vs actuals. Pure read-only; run anytime.
import json, sqlite3, statistics, glob, os
PROD = "/root/corps-place/sdk/dci-relational.db"
SHADOW = "/home/patrick/v10-shadow"
CAPS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"]
LBL = {"GE 1": "GE1", "GE 2": "GE2", "VP": "VP", "VA": "VA", "CG": "CG", "MB": "MB", "MA": "MA", "MP": "MP"}
db = sqlite3.connect(f"file:{PROD}?mode=ro", uri=True)

def actual_total(slug):
    return {ck: t for ck, t in db.execute("SELECT corps_key,total_score FROM corps_scores WHERE competition_slug=?", (slug,))}
def actual_caps(slug):
    d = {}
    for ck, ci, sc in db.execute("SELECT corps_key,caption_initials,score FROM caption_scores WHERE competition_slug=?", (slug,)):
        c = LBL.get(ci)
        if c and sc is not None: d.setdefault(ck, {})[c] = sc
    return {k: v for k, v in d.items() if len(v) == 8}
def final2_pred(slug):
    r = db.execute("SELECT payload_json FROM model_event_prediction_runs WHERE event_slug=? ORDER BY predicted_at DESC LIMIT 1", (slug,)).fetchone()
    if not r: return {}
    return {p["corps_key"]: p for p in json.loads(r[0]).get("predictions", []) if p.get("corps_key")}

# earliest shadow forecast per event (the most out-of-sample snapshot)
forecasts = {}
for f in sorted(glob.glob(f"{SHADOW}/*/*.json")):
    slug = os.path.basename(f)[:-5]
    forecasts.setdefault(slug, f)  # first (earliest date) wins

v10_recap, f2_recap, v10_tot, f2_tot = [], [], [], []
resolved = 0
print(f"{'event':40}{'n':>3}{'V10 recap':>11}{'f2 recap':>10}{'V10 tot':>9}{'f2 tot':>8}")
for slug, f in sorted(forecasts.items()):
    A_t, A_c = actual_total(slug), actual_caps(slug)
    if not A_t: continue  # not scored yet
    resolved += 1
    V = {p["corps_key"]: p for p in json.load(open(f)).get("predictions", []) if p.get("corps_key")}
    F = final2_pred(slug)
    vr, fr, vt, ft = [], [], [], []
    for ck, ac in A_c.items():
        if ck in V and all(V[ck].get(c) is not None for c in CAPS):
            vr.append(statistics.mean(abs(V[ck][c] - ac[c]) for c in CAPS))
        if ck in F and all(F[ck].get(c) is not None for c in CAPS):
            fr.append(statistics.mean(abs(F[ck][c] - ac[c]) for c in CAPS))
    for ck, at in A_t.items():
        if ck in V and V[ck].get("total") is not None: vt.append(abs(V[ck]["total"] - at))
        if ck in F and F[ck].get("total") is not None: ft.append(abs(F[ck]["total"] - at))
    v10_recap += vr; f2_recap += fr; v10_tot += vt; f2_tot += ft
    m = lambda x: statistics.mean(x) if x else float("nan")
    print(f"{slug[:40]:40}{len(vr):>3}{m(vr):>11.3f}{m(fr):>10.3f}{m(vt):>9.3f}{m(ft):>8.3f}")

print("-" * 82)
if resolved == 0:
    print("No shadow events have been scored yet — check back after upcoming shows resolve.")
else:
    m = lambda x: statistics.mean(x) if x else float("nan")
    print(f"RESOLVED {resolved} events. OVERALL:")
    print(f"  recap MAE: V10 {m(v10_recap):.4f}  vs final2 {m(f2_recap):.4f}  ({100*(m(f2_recap)-m(v10_recap))/m(f2_recap):+.1f}%)")
    print(f"  total MAE: V10 {m(v10_tot):.4f}  vs final2 {m(f2_tot):.4f}  ({100*(m(f2_tot)-m(v10_tot))/m(f2_tot):+.1f}%)")
    print("  (V10 is a genuine forward test — forecast BEFORE the show, no target scores.)")
