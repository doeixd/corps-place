// Fix staff display-name casing + drop sentence-fragment junk names (data-quality).
//   • ALL-CAPS names  → Title Case  ("MEGAN O'LEARY" → "Megan O'Leary").
//   • Sentence-fragment "names" mis-split from bio prose → DELETE
//       ("two clinics in Central Ohio", 'roll. Steven Bryant's "Ecstatic Waters', "by Steven Reineke").
// Dry-run default; --apply writes. Run mergeByNameDefault.ts afterward (title-cased names may
// now match an existing properly-cased twin).
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

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s'’.\-])([a-z])/g, (_, b, c) => b + c.toUpperCase());

// A real name is capitalized; a bio fragment mis-split into a "name" starts lowercase
// ("two clinics in Central Ohio", "by Steven Reineke", "recycling. John Adams' …"). This is
// the ONLY reliable signal — quote (nicknames "JJ"), "Dr."/"St." (honorific/surname), and
// initials ("W.") all occur in REAL names, so don't use those.
const isFragment = (s: string) => /^[a-z]/.test(s.trim());

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const recase: { staff_id: string; from: string; to: string }[] = [];
  const del: { staff_id: string; name: string }[] = [];
  for (const r of rows) {
    const name = String(r.display_name).trim();
    const allCaps = name === name.toUpperCase() && /[A-Z]/.test(name) && name.length >= 4;
    // isFragment (stopword-start / embedded quote / two sentences) is itself decisive junk —
    // a real name never starts with "the/two/by…" nor contains a quote. Guard only the rare
    // "Jr. Capital" mid-sentence case by sparing clean 2-token names.
    if (isFragment(name) && !(looksLikePersonName(name) && name.split(/\s+/).length <= 2)) { del.push({ staff_id: r.staff_id, name }); continue; }
    if (allCaps) { const t = titleCase(name); if (t !== name) recase.push({ staff_id: r.staff_id, from: name, to: t }); }
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${recase.length} to re-case, ${del.length} fragment names to delete\n`);
  console.log("RE-CASE:"); recase.slice(0, 20).forEach((c) => console.log(`  "${c.from}" → "${c.to}"`));
  console.log("\nDELETE (bio fragment):"); del.slice(0, 25).forEach((d) => console.log(`  "${d.name}"`));
  if (!DRY) {
    for (const c of recase) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [c.to, c.staff_id] });
    for (const d of del) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [d.staff_id] });
    console.log(`\nApplied: re-cased ${recase.length}, deleted ${del.length}.`);
  }
  process.exit(0);
};
main();
