// Mine structured facts from JUDGE bios (parallel to mineBioFacts for staff). Uses the same
// deterministic parser; grounds performing-history corps via mapCorps; person-grounds (the bio
// must mention the judge's name). Writes to judge_bio_facts (judge_id, fact_type, value, detail).
// Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { parseBioFacts } from "../src/bioFactsParse.js";
import { buildCorpsResolver } from "../src/yearbook/mapCorps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const apply = process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });
const now = new Date().toISOString();
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

const main = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS judge_bio_facts (
      judge_id TEXT NOT NULL, fact_type TEXT NOT NULL, value TEXT NOT NULL,
      detail_json TEXT, source_kind TEXT, confidence TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (judge_id, fact_type, value))`);
  if (apply) await db.execute("PRAGMA busy_timeout=15000");
  const resolve_ = await buildCorpsResolver(db as any);
  const rows = (await db.execute("SELECT judge_id, display_name, biography FROM judges WHERE length(trim(coalesce(biography,'')))>=80")).rows as any[];

  let nPerf = 0, nPerfRaw = 0, nEdu = 0, nAward = 0, nPos = 0, nHome = 0, nJudges = 0, nMis = 0;
  for (const r of rows) {
    const nbio = norm(String(r.biography));
    const parts = String(r.display_name ?? "").split(/\s+/).filter((w: string) => norm(w).length >= 3).map(norm);
    if (parts.length && !parts.some((p: string) => nbio.includes(p))) { nMis++; continue; } // bio not about this judge
    const f = parseBioFacts(r.biography);
    if (!f.performed.length && !f.education.length && !f.awards.length && !f.currentPosition && !f.hometown) continue;
    nJudges++;
    const put = async (fact_type: string, value: string, detail: any, conf: string) => {
      if (!apply || !value) return;
      await db.execute({ sql: `INSERT INTO judge_bio_facts (judge_id,fact_type,value,detail_json,source_kind,confidence,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(judge_id,fact_type,value) DO UPDATE SET detail_json=excluded.detail_json, confidence=excluded.confidence`, args: [r.judge_id, fact_type, value, JSON.stringify(detail), "bio-parser", conf, now] });
    };
    for (const p of f.performed) {
      const m = resolve_({ corpsName: p.group });
      if (m) { nPerf++; await put("performed", p.group, { corps_key: m.corpsKey, startYear: p.startYear, endYear: p.endYear }, "HIGH"); }
      else { nPerfRaw++; await put("performed-other", p.group, { startYear: p.startYear, endYear: p.endYear }, "MEDIUM"); }
    }
    for (const e of f.education) { nEdu++; await put("education", e.institution ?? e.degree ?? "", { degree: e.degree, field: e.field, year: e.year }, e.degree && e.institution ? "HIGH" : "MEDIUM"); }
    for (const a of f.awards) { nAward++; await put("award", a.name, { year: a.year }, "MEDIUM"); }
    if (f.currentPosition) { nPos++; await put("position", `${f.currentPosition.title} @ ${f.currentPosition.org}`, f.currentPosition, "MEDIUM"); }
    if (f.hometown) { nHome++; await put("hometown", f.hometown, {}, "MEDIUM"); }
  }
  console.log(`${apply ? "APPLIED" : "(dry-run)"} over ${rows.length} judge bios → ${nJudges} with facts (${nMis} skipped: bio not about judge):`);
  console.log(`  performed(grounded)=${nPerf} performed(raw)=${nPerfRaw} education=${nEdu} award=${nAward} position=${nPos} hometown=${nHome}`);
  process.exit(0);
};
main();
