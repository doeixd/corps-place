import json, csv, statistics, glob, sys

def derived(r): return r[0]+r[1]+sum(r[2:8])/2
cohort={}
for row in csv.DictReader(open("/tmp/evalcohort.csv")):
    cohort[(row["competition_slug"],row["corps_key"])]=float(row["y_total"])

files=sys.argv[1:] or sorted(glob.glob("results/v10-2026-*agnostic.json"))
# exclude non-model (e.g. supportid/thinhist) unless explicitly passed
if len(sys.argv)<=1:
    files=[f for f in files if ("dev3-s" in f or "phaseaware" in f)]
P={}; A={}
for f in files:
    rows=json.load(open(f))["raw"]["history_details"]
    P[f]={(d["competition_slug"],d["corps_key"]):d["predicted_recap"] for d in rows}
    A[f]={(d["competition_slug"],d["corps_key"]):d.get("actual_recap") for d in rows}
keys=set(cohort)
for f in P: keys&=set(P[f])
anyA=next(iter(A.values()))
keys=[k for k in keys if anyA.get(k)]
def tmae(pred): return statistics.mean(abs(pred[k]-cohort[k]) for k in keys)
def rmae(predr): return statistics.mean(abs(predr[k][i]-anyA[k][i]) for k in keys for i in range(8))
print(f"combined ensemble of {len(P)} models, {len(keys)} rows:")
for f in sorted(P): print(f"  {f.split('/')[-1][:40]}: recap {rmae(P[f]):.4f}")
ens={k:[statistics.mean(P[f][k][i] for f in P) for i in range(8)] for k in keys}
print(f"  COMBINED ENSEMBLE: recap {rmae(ens):.4f}  total {tmae({k:derived(ens[k]) for k in keys}):.4f}")
print("  final2 (agnostic): recap 0.4930 total 1.5141")
