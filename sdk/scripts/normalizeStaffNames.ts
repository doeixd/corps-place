// Normalize staff display names + drop residual non-person rows (user: honorifics, leaked junk).
//   • STRIP a leading honorific → "Dr. Andrew Putnam" → "Andrew Putnam", "Dr Dan Fong" → "Dan Fong"
//     (consistent form + lets the honorific twin merge with the plain name). Kept only if ≥2 tokens
//     remain.
//   • STRIP a leaked URL/domain and everything after it, and stray "REPERTOIRE" tokens →
//     "Scott Lang arizonaacademy.org Tempe" → "Scott Lang".
//   • DELETE rows that reduce to a non-name (e.g. "CA … incognitodbc.org Incognito").
// Dry-run default; --apply writes. Run mergeByNameDefault + mergeNameVariants afterward.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { looksLikePersonName } from "../src/staffScraper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const HONORIFIC = /^(dr|mr|mrs|ms|miss|mx|prof|professor|sir|dame|rev|fr|capt|sgt)\.?\s+/i;
const normalize = (raw: string): string => {
  let s = raw.trim();
  s = s.replace(/\s*\b\S*\.(org|com|net|edu)\b.*$/i, "");      // drop leaked URL + trailing city
  s = s.replace(/\bREPERTOIRE\b/gi, " ");                        // stray section marker
  const stripped = s.replace(HONORIFIC, "");                     // honorific (only if ≥2 tokens remain)
  if (stripped.trim().split(/\s+/).filter(Boolean).length >= 2) s = stripped;
  return s.replace(/\s+/g, " ").trim();
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const renames: { staff_id: string; from: string; to: string }[] = [];
  const dels: { staff_id: string; name: string }[] = [];
  for (const r of rows) {
    const from = String(r.display_name);
    const to = normalize(from);
    if (to === from) continue;
    if (to.length >= 4 && looksLikePersonName(to)) renames.push({ staff_id: r.staff_id, from, to });
    else if (to.length < 4 || !/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(to)) dels.push({ staff_id: r.staff_id, name: from });
    else renames.push({ staff_id: r.staff_id, from, to }); // changed to a 2-word form looksLikePersonName may false-reject
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${renames.length} renames, ${dels.length} deletes\n`);
  console.log("RENAME:"); [...new Map(renames.map((r) => [r.from, r])).values()].slice(0, 25).forEach((r) => console.log(`  "${r.from}" → "${r.to}"`));
  console.log("\nDELETE:"); dels.slice(0, 10).forEach((d) => console.log(`  "${d.name}"`));
  if (!DRY) {
    for (const r of renames) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    for (const d of dels) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [d.staff_id] });
    console.log(`\nApplied ${renames.length} renames, ${dels.length} deletes.`);
  }
  process.exit(0);
};
main();
