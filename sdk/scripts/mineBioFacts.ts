// S3 ingest — mine structured facts from staff bio prose (docs/staff-quality-plan.md).
//
// Runs the deterministic parser (src/bioFactsParse.ts) over every staff bio and writes:
//   • performing history → corps_staff_affiliations (relation_type='performed'), GROUNDED to a
//     corps via mapCorps; unmatched groups are kept in staff_bio_facts (fact_type='performed').
//   • education / award / position / hometown → staff_bio_facts.
// Anti-hallucination: a performed CORPS is only linked when mapCorps resolves it. Re-runnable;
// --apply writes (busy_timeout for the shared DB). An AI fallback (S3.3) handles the rest.
//
// Usage (from sdk/):  npx tsx scripts/mineBioFacts.ts [--corps <key>] [--limit N] [--apply]
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadRepoEnv } from "./scriptEnv.js";
import { parseBioFacts } from "../src/bioFactsParse.js";
import { buildCorpsResolver } from "../src/yearbook/mapCorps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const corpsFilter = args.includes("--corps") ? args[args.indexOf("--corps") + 1] : undefined;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });
const now = new Date().toISOString();
const yr = (n: number | null) => (n === null ? null : String(n));
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

const main = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS staff_bio_facts (
      staff_id TEXT NOT NULL, person_id TEXT, fact_type TEXT NOT NULL, value TEXT NOT NULL,
      detail_json TEXT, source_url TEXT, source_kind TEXT, confidence TEXT, evidence TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (staff_id, fact_type, value))`);
  if (apply) await db.execute("PRAGMA busy_timeout=15000");
  const resolve_ = await buildCorpsResolver(db as any);

  const where = corpsFilter
    ? "JOIN corps_staff_assignments a ON a.staff_id=cs.staff_id AND a.corps_key=?"
    : "";
  const sql = `SELECT DISTINCT cs.staff_id, cs.person_id, cs.display_name, cs.biography
                 FROM corps_staff cs ${where}
                WHERE length(trim(coalesce(cs.biography,'')))>=80`;
  const rows = (await db.execute(corpsFilter ? { sql, args: [corpsFilter] } : sql)).rows as any[];
  const targets = limit ? rows.slice(0, limit) : rows;

  let nPerf = 0, nPerfRaw = 0, nEdu = 0, nAward = 0, nPos = 0, nHome = 0, nStaff = 0, nMisassigned = 0;
  const examples: string[] = [];
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

  for (const r of targets) {
    // GROUND the bio to the person: some grid-scraped rows carry a bio that's actually about
    // someone else (mis-extraction). Only mine when the bio mentions the person's given OR
    // family name — otherwise the facts (corps, school…) would be attributed to the wrong person.
    const nbio = norm(r.biography ?? "");
    const parts = String(r.display_name ?? "").split(/\s+/).filter((w: string) => norm(w).length >= 3).map(norm);
    if (parts.length && !parts.some((p: string) => nbio.includes(p))) { nMisassigned++; continue; }
    const f = parseBioFacts(r.biography);
    if (!f.performed.length && !f.education.length && !f.awards.length && !f.currentPosition && !f.hometown) continue;
    nStaff++;

    const bioFact = async (fact_type: string, value: string, detail: any, confidence: string, evidence: string) => {
      if (!apply) return;
      await db.execute({
        sql: `INSERT INTO staff_bio_facts (staff_id,person_id,fact_type,value,detail_json,source_url,source_kind,confidence,evidence,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(staff_id,fact_type,value) DO UPDATE SET person_id=excluded.person_id, detail_json=excluded.detail_json, confidence=excluded.confidence, evidence=excluded.evidence`,
        args: [r.staff_id, r.person_id ?? null, fact_type, value, JSON.stringify(detail), null, "bio-parser", confidence, evidence.slice(0, 240), now],
      });
    };

    for (const p of f.performed) {
      const match = resolve_({ corpsName: p.group });
      if (match) {
        nPerf++;
        if (apply) {
          const id = `${r.staff_id}:performed:${match.corpsKey}`;
          await db.execute({
            sql: `INSERT INTO corps_staff_affiliations (affiliation_id,staff_id,related_corps_key,relation_type,notes,since_season,through_season)
                  VALUES (?,?,?,?,?,?,?)
                  ON CONFLICT(affiliation_id) DO UPDATE SET since_season=COALESCE(excluded.since_season,since_season), through_season=COALESCE(excluded.through_season,through_season)`,
            args: [id, r.staff_id, match.corpsKey, "performed", p.evidence.slice(0, 240), yr(p.startYear), yr(p.endYear)],
          });
        }
        if (examples.length < 12) examples.push(`perf  ${r.display_name}: ${p.group}${p.startYear ? ` (${p.startYear}${p.endYear ? "-" + p.endYear : ""})` : ""} → ${match.corpsKey} [${match.method}]`);
      } else {
        nPerfRaw++;
        await bioFact("performed", p.group, { startYear: p.startYear, endYear: p.endYear }, "MEDIUM", p.evidence);
      }
    }
    for (const e of f.education) {
      nEdu++;
      await bioFact("education", e.institution ?? e.degree ?? "", { degree: e.degree, field: e.field, year: e.year }, e.degree && e.institution ? "HIGH" : "MEDIUM", e.evidence);
    }
    for (const a of f.awards) { nAward++; await bioFact("award", a.name, { year: a.year }, "MEDIUM", ""); }
    if (f.currentPosition) { nPos++; await bioFact("position", `${f.currentPosition.title} @ ${f.currentPosition.org}`, f.currentPosition, "MEDIUM", ""); }
    if (f.hometown) { nHome++; await bioFact("hometown", f.hometown, {}, "MEDIUM", ""); }
  }

  console.log(`${apply ? "APPLIED" : "(dry-run)"} over ${targets.length} bios → ${nStaff} staff with facts (${nMisassigned} skipped: bio didn't mention the person):`);
  console.log(`  performed(grounded)=${nPerf}  performed(raw)=${nPerfRaw}  education=${nEdu}  award=${nAward}  position=${nPos}  hometown=${nHome}`);
  console.log("\nExamples:\n  " + examples.join("\n  "));
  process.exit(0);
};
main();
