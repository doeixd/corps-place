// Final name micro-fixes:
//   • STRIP a title-case corps+city suffix ("Edgar Santana Blue Devils BConcord" → "Edgar Santana";
//     "CA Blue Devils B" strips to non-name → delete).
//   • FIX a double-capital OCR typo where the 2nd letter was wrongly capitalized:
//     "MIchael"→"Michael", "RIttenhouse"→"Rittenhouse". SPARES O'/D'/L' names (OHara=O'Hara,
//     DAngelo=D'Angelo), Mc/Mac, and initials — only consonant-start words (minus D/L) are fixed.
// Dry-run default; --apply writes.
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

const fix = (raw: string): string =>
  raw.replace(/\s+Blue Devils\b.*$/i, "")                                   // strip leaked corps+city
     .replace(/\b([BCFGHJKMNPQRSTVWXZ])([A-Z])([a-z]{2,})/g, (_, a, b, c) => a + b.toLowerCase() + c) // double-cap typo
     .replace(/\s+/g, " ").trim();

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name LIKE '% Blue Devils %' OR display_name GLOB '*[A-Z][A-Z][a-z]*'")).rows as any[];
  const renames: { staff_id: string; from: string; to: string }[] = [];
  const dels: { staff_id: string; name: string }[] = [];
  for (const r of rows) {
    const from = String(r.display_name);
    const to = fix(from);
    if (to === from) continue;
    if (looksLikePersonName(to)) renames.push({ staff_id: r.staff_id, from, to });
    else dels.push({ staff_id: r.staff_id, name: from });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${renames.length} renames, ${dels.length} deletes\n`);
  console.log("RENAME:"); [...new Map(renames.map((r) => [r.from, r])).values()].slice(0, 20).forEach((r) => console.log(`  "${r.from}" → "${r.to}"`));
  console.log("\nDELETE:"); [...new Set(dels.map((d) => d.name))].slice(0, 10).forEach((n) => console.log(`  "${n}"`));
  if (!DRY) {
    for (const r of renames) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    for (const d of dels) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [d.staff_id] });
    console.log(`\nApplied ${renames.length} renames, ${dels.length} deletes.`);
  }
  process.exit(0);
};
main();
