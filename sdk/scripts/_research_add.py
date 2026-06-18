import json, os
TARGETS='results/corps-onsite-missing-targets.json'
OUT='results/corps-research-onsite-batch.json'
_t=json.load(open(TARGETS,encoding='utf-8'))['targets']
tg={t['slug']:t for t in _t if t['slug']}
tg_by_key={t['corps_key']:t for t in _t}
data={}
if os.path.exists(OUT):
    for e in json.load(open(OUT,encoding='utf-8')): data[e['corps_key']]=e
def add(slug=None, key=None, confidence='high', **fields):
    t=tg.get(slug) if slug else tg_by_key.get(key)
    if not t: raise SystemExit(f'no target for slug={slug} key={key}')
    k=t['corps_key']
    e=data.get(k,{'corps_key':k,'name':t['name'],'slug':t['slug'],'confidence':confidence,'fields':{}})
    e['confidence']=confidence
    e['fields'].update({fk:fv for fk,fv in fields.items() if fv is not None})
    data[k]=e
    print('added',t['name'],list(fields))
def save():
    json.dump(list(data.values()),open(OUT,'w',encoding='utf-8'),indent=2,ensure_ascii=False)
    print('TOTAL entries:',len(data))
