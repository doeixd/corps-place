import json, os, sys
TARGETS='results/corps-onsite-missing-targets.json'
OUT='results/corps-research-onsite-batch.json'
_t=json.load(open(TARGETS,encoding='utf-8'))['targets']
tg={t['slug']:t for t in _t if t['slug']}
tg_by_key={t['corps_key']:t for t in _t}
data={}
if os.path.exists(OUT):
    for e in json.load(open(OUT,encoding='utf-8')): data[e['corps_key']]=e
# additions file path passed as argv[1]; format: list of {slug?,key?,confidence?,fields:{}}
adds=json.load(open(sys.argv[1],encoding='utf-8'))
for a in adds:
    t=tg.get(a.get('slug')) if a.get('slug') else tg_by_key.get(a.get('key'))
    if not t: raise SystemExit(f"no target for {a}")
    k=t['corps_key']
    e=data.get(k,{'corps_key':k,'name':t['name'],'slug':t['slug'],'confidence':a.get('confidence','high'),'fields':{}})
    e['confidence']=a.get('confidence','high')
    e['fields'].update({fk:fv for fk,fv in a['fields'].items() if fv is not None})
    data[k]=e
    print('merged',t['name'],list(a['fields']))
json.dump(list(data.values()),open(OUT,'w',encoding='utf-8'),indent=2,ensure_ascii=False)
print('TOTAL entries:',len(data))
