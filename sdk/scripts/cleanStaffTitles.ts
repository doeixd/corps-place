// Normalize default_title + drop a few non-person records (data-quality).
//   • CLEAR junk titles → NULL: zip codes ("WI 54602"), sentence/ad fragments ("we make better
//     people…", "free pair of Innovative Percussion sticks"), email/URL, or >8-word prose.
//   • TITLE-CASE all-lowercase valid titles ("brass" → "Brass", "corps director" → "Corps Director").
//   • DELETE display_names that are clearly not a person: pipe-merged ("A| B"), or org/class
//     labels ("Hit Counter", "Saints - DCA Class A", "… Performing Arts").
// Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const titleCase = (s: string) =>
  s.toLowerCase()
    .replace(/(^|[\s'’.\-/&])([a-z])/g, (_, b, c) => b + c.toUpperCase())
    .replace(/(\S\s+)(And|Of|The|For|To|In|On|At|An|A)\b/g, (_, p, w) => p + w.toLowerCase()); // keep small words lowercase
// A trailing abbreviation ("… Caption Mgr.", "Co-Coord.") ends in a period but is NOT a sentence.
const ABBR_END = /\b(Mgr|Coord|Consult|Asst|Assoc|Dir|Jr|Sr|Inc|Co|Corp|Ltd|Dept|Univ|Assn|Bros|Mr|Mrs|Ms|Dr|Prof|Adm|Ed|Mvt|Op|No|Vol)\.?$/i;
const isJunkTitle = (t: string) => {
  const x = t.trim();
  return /\b[A-Z]{2}\s+\d{5}\b/.test(x) ||                                 // zip ("WI 54602")
    /@|https?:\/\//i.test(x) ||
    /\b(we make|by experience|free pair|motivation within|teaching personal|better people|volunteer of the year|he was|she was|was named|the .* high school)\b/i.test(x) ||
    (/[.!?]$/.test(x) && !ABBR_END.test(x));                              // sentence end (not an abbrev.)
};
// Non-person display name: pipe-merged, or an org/class/page label (definitive — no name check).
const isNonPerson = (n: string) =>
  /\|/.test(n) || /\b(DCA|Class A{1,3}\b|Performing Arts|Hit Counter|Mini Corps|Concert Corps|Holiday Brass)\b/.test(n);

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name, default_title FROM corps_staff")).rows as any[];
  const clearT: any[] = [], caseT: any[] = [], delN: any[] = [];
  for (const r of rows) {
    if (r.display_name && isNonPerson(String(r.display_name))) { delN.push(r); continue; }
    const t = r.default_title ? String(r.default_title).trim() : "";
    if (!t) continue;
    if (isJunkTitle(t)) clearT.push(r);
    else if (t === t.toLowerCase() && /[a-z]/.test(t)) caseT.push({ ...r, to: titleCase(t) });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — clear ${clearT.length} junk titles, title-case ${caseT.length}, delete ${delN.length} non-person rows\n`);
  console.log("CLEAR TITLE:"); clearT.slice(0, 12).forEach((r) => console.log(`  [${r.default_title}]`));
  console.log("\nTITLE-CASE:"); caseT.slice(0, 8).forEach((r) => console.log(`  "${r.default_title}" → "${r.to}"`));
  console.log("\nDELETE ROW:"); delN.slice(0, 12).forEach((r) => console.log(`  "${r.display_name}"`));
  if (!DRY) {
    for (const r of clearT) await db.execute({ sql: "UPDATE corps_staff SET default_title=NULL WHERE staff_id=?", args: [r.staff_id] });
    for (const r of caseT) await db.execute({ sql: "UPDATE corps_staff SET default_title=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    for (const r of delN) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [r.staff_id] });
    console.log(`\nApplied: ${clearT.length} titles cleared, ${caseT.length} title-cased, ${delN.length} rows deleted.`);
  }
  process.exit(0);
};
main();
