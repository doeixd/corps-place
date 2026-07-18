import json, csv, statistics, sys, os

def derived(r): return r[0]+r[1]+sum(r[2:8])/2

cohort={}
for row in csv.DictReader(open("/tmp/evalcohort.csv")):
    cohort[(row["competition_slug"],row["corps_key"])]=float(row["y_total"])

def load(path):
    rows=json.load(open(path))["raw"]["history_details"]
    preds={(d["competition_slug"],d["corps_key"]):d["predicted_recap"] for d in rows}
    acts={(d["competition_slug"],d["corps_key"]):d.get("actual_recap") for d in rows}
    return preds, acts

seeds=sys.argv[1:] if len(sys.argv)>1 else ["42","43","44"]
S={}; A={}
for s in seeds:
    for pat in (f"results/v10-2026-dev3-s{s}-term-agnostic.json",
                f"results/v10-2026-dev3-s{s}-agnostic.json"):
        if os.path.exists(pat):
            S[s],A[s]=load(pat); break
    else:
        print(f"  seed{s}: missing, skipped")
keys=set(cohort)
for s in S: keys&=set(S[s])
keys=[k for k in keys if A[list(S)[0]].get(k)]
def tmae(pm): return statistics.mean(abs(pm[k]-cohort[k]) for k in keys)
def rmae(pm): return statistics.mean(abs(pm[k][i]-A[list(S)[0]][k][i]) for k in keys for i in range(8))
print(f"rows {len(keys)}, seeds {list(S)}")
for s in S:
    print(f"  seed{s}: total {tmae({k:derived(S[s][k]) for k in keys}):.4f}  recap {rmae(S[s]):.4f}")
ensr={k:[statistics.mean(S[s][k][i] for s in S) for i in range(8)] for k in keys}
print(f"  {len(S)}-SEED ENSEMBLE: total {tmae({k:derived(ensr[k]) for k in keys}):.4f}  recap {rmae(ensr):.4f}")
print(f"  final2 (agnostic, same cohort ref): recap 0.4930 total 1.5141")
