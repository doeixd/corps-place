// Generate the next batch of prominent missing-bio targets, EXCLUDING anyone already
// attempted in a prior results/staff-research/batch-*.json (HIGH/MEDIUM are auto-excluded
// by the no-bio filter; this also drops the repeat LOWs so each batch is fresh names).
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const N = Number(process.argv[2] ?? 60);
const out = process.argv[3] ?? "results/staff-research/_input-next.json";
const db = createClient({ url: "file:dci-relational.db" });
const attempted = new Set();
for (const f of readdirSync("results/staff-research")) {
  if (f.startsWith("batch-") && f.endsWith(".json")) {
    try { for (const r of JSON.parse(readFileSync("results/staff-research/" + f, "utf8"))) attempted.add(r.person_id); } catch {}
  }
}
const r = await db.execute(`SELECT cs.person_id,cs.display_name,count(distinct a.corps_key) corps,count(distinct a.season) seasons,group_concat(distinct c.name) corps_names,group_concat(distinct a.role_type) roles FROM corps_staff cs JOIN corps_staff_assignments a ON a.staff_id=cs.staff_id LEFT JOIN corps c ON c.corps_key=a.corps_key WHERE cs.person_id IS NOT NULL GROUP BY cs.person_id HAVING MAX(case when length(trim(coalesce(cs.biography,'')))>=40 then 1 else 0 end)=0 AND corps>=2 ORDER BY corps DESC, seasons DESC`);
const list = r.rows.filter(x => !attempted.has(x.person_id)).slice(0, N).map(x => ({ person_id: x.person_id, display_name: x.display_name, corps_names: (x.corps_names||"").split(","), roles: (x.roles||"").split(","), hasphoto: false }));
writeFileSync(out, JSON.stringify(list));
console.log(`wrote ${list.length} fresh targets (excluded ${attempted.size} already-attempted) → ${out}`);
