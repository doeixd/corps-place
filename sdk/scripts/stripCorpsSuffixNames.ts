// Clean corps/org names leaked into staff display names + drop accolade non-person rows.
//   • STRIP a trailing ALL-CAPS org/corps suffix → "Maverick Peterson BLUE DEVILS B" →
//     "Maverick Peterson", "Paul Weber RIVER CITY RHYTHM" → "Paul Weber", "Linda Garbarino BOD" →
//     "Linda Garbarino". SPARES roman-numeral suffixes (II/III/IV) and single-letter initials.
//   • FIX a double-capital typo: "AJ RIttenhouse" → "AJ Rittenhouse" (RI→Ri; not Mc/Mac/La/O').
//   • DELETE accolade/non-person rows: "Three-Time WGI Semi-Finalist", "Rhythm IN BLUE", "Bixby HS".
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

const ROMAN = /^(II|III|IV|V|VI|VII|VIII|IX|X)$/;
const ORG1 = /^(BOD|HS|DBC|PAA|RCR|WGI|DCI|MS|BS|MA|BA)$/; // single-token org/abbrev that can be stripped
const ACCOLADE = /\b(time\b.*\b(finalist|champion|semi-?finalist)|WGI (Semi-?)?Finalist|DCI .*Finalist|^Rhythm IN |HS$|High School$)\b/i;

// Strip a trailing run of ALL-CAPS tokens (≥2 tokens, e.g. "BLUE DEVILS B"), or one ORG1 token.
const stripSuffix = (raw: string): string => {
  const t = raw.trim().split(/\s+/);
  let end = t.length;
  // collect trailing all-caps (len≥2 or single-letter) tokens, but stop at roman numerals.
  const isCaps = (w: string) => /^[A-Z][A-Z.&-]*$/.test(w) && !ROMAN.test(w);
  let run = 0;
  while (end > 0 && isCaps(t[end - 1]!)) { end--; run++; }
  if (run >= 2) return t.slice(0, end).join(" ").trim();                 // multi-word org suffix
  if (run === 1 && ORG1.test(t[t.length - 1]!.replace(/[.]/g, ""))) return t.slice(0, t.length - 1).join(" ").trim();
  return raw.trim();
};
const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const renames: { staff_id: string; from: string; to: string }[] = [];
  const dels: { staff_id: string; name: string }[] = [];
  for (const r of rows) {
    const from = String(r.display_name);
    if (ACCOLADE.test(from)) { dels.push({ staff_id: r.staff_id, name: from }); continue; }
    const to = stripSuffix(from);
    if (to !== from) {
      if (looksLikePersonName(to)) renames.push({ staff_id: r.staff_id, from, to });
      else dels.push({ staff_id: r.staff_id, name: from }); // stripped to a non-name (it was a corps)
    }
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${renames.length} renames, ${dels.length} deletes\n`);
  console.log("RENAME:"); [...new Map(renames.map((r) => [r.from, r])).values()].slice(0, 20).forEach((r) => console.log(`  "${r.from}" → "${r.to}"`));
  console.log("\nDELETE:"); [...new Set(dels.map((d) => d.name))].slice(0, 15).forEach((n) => console.log(`  "${n}"`));
  if (!DRY) {
    for (const r of renames) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    for (const d of dels) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [d.staff_id] });
    console.log(`\nApplied ${renames.length} renames, ${dels.length} deletes.`);
  }
  process.exit(0);
};
main();
