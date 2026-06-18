// Normalize job titles in BOTH corps_staff.default_title and corps_staff_assignments.title:
//   • SPACING: "Colorguard" → "Color Guard", "Frontensemble" → "Front Ensemble".
//   • CLEAR junk titles → NULL: zip ("WI 54602"), sentence/ad fragments, email/URL — but SPARE
//     abbreviations ending in a period ("Caption Mgr.", "Co-Coord.") via an ABBR_END list.
// (default_title junk was cleared earlier; this also covers assignment titles.) Dry-run default.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const ABBR_END = /\b(Mgr|Coord|Consult|Asst|Assoc|Dir|Jr|Sr|Inc|Co|Corp|Ltd|Dept|Univ|Assn|Bros|Mr|Mrs|Ms|Dr|Prof|Adm|Ed|Mvt|Op|No|Vol)\.?$/i;
const isJunk = (t: string) => {
  const x = t.trim();
  return /\b[A-Z]{2}\s+\d{5}\b/.test(x) || /@|https?:\/\//i.test(x) ||
    /\b(we make|by experience|free pair|motivation within|teaching personal|better people|volunteer of the year|he was|she was|was named)\b/i.test(x) ||
    (/[.!?]$/.test(x) && !ABBR_END.test(x));
};
const respace = (t: string) =>
  t.replace(/\bColorguard\b/g, "Color Guard").replace(/\bColorGuard\b/g, "Color Guard")
   .replace(/\bFrontensemble\b/gi, "Front Ensemble").replace(/\s+/g, " ").trim();

const run = async (table: string, idCol: string) => {
  const rows = (await db.execute(`SELECT ${idCol} id, title, ${table === "corps_staff" ? "default_title" : "title"} v FROM ${table}`).catch(() => ({ rows: [] }))) as any;
  // unify: read the title column directly
  const col = table === "corps_staff" ? "default_title" : "title";
  const data = (await db.execute(`SELECT ${idCol} id, ${col} v FROM ${table} WHERE ${col} IS NOT NULL AND TRIM(${col})!=''`)).rows as any[];
  let cleared = 0, respaced = 0;
  for (const r of data) {
    const v = String(r.v);
    if (isJunk(v)) { if (!DRY) await db.execute({ sql: `UPDATE ${table} SET ${col}=NULL WHERE ${idCol}=?`, args: [r.id] }); cleared++; continue; }
    const rs = respace(v);
    if (rs !== v) { if (!DRY) await db.execute({ sql: `UPDATE ${table} SET ${col}=? WHERE ${idCol}=?`, args: [rs, r.id] }); respaced++; }
  }
  void rows;
  console.log(`  ${table}.${col}: cleared ${cleared} junk, respaced ${respaced}`);
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  console.log(`${DRY ? "(dry-run)" : "APPLIED"}:`);
  await run("corps_staff", "staff_id");
  await run("corps_staff_assignments", "assignment_id");
  process.exit(0);
};
main();
