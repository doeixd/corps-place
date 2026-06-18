// Clear "roster-line" bios: short, verbless strings that are just the person's name + a list
// of role/title labels ("Jim Wunderlich Brass Arranger, Front Ensemble Arranger, Music
// Coordinator") — useless as a bio (the title is already a field), and worse than showing none.
// A REAL bio has narrative (a verb/pronoun); we only clear short bios that have none.
// Clears corps_staff.biography AND removes the matching candidate so a re-emit can't resurrect it.
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

// Markers of a real narrative bio (a verb, pronoun, or biographical noun). If a SHORT bio has
// none of these, it's a roster line, not prose.
const NARRATIVE = /\b(is|was|are|were|has|have|had|been|began|begins?|marched|performs?|performed|serves?|served|earns?|earned|holds?|held|teaches|taught|joins?|joined|studies|studied|receiv\w+|currently|graduat\w+|grew up|aged out|his|her|their|he|she|they|brings?|enjoys?|starts?|started|completed|attend\w+|works?|worked|native|member of|resides?|lives?|founder|founded|degree|alumn\w+|career|résumé|resume|boasts?|based in|recipient|holds a|earned a|received a)\b/i;
const isRosterLine = (bio: string) => { const b = bio.replace(/\s+/g, " ").trim(); return b.length < 160 && !NARRATIVE.test(b); };

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name, biography FROM corps_staff WHERE length(trim(coalesce(biography,'')))>=40")).rows as any[];
  const hits = rows.filter((r) => isRosterLine(String(r.biography)));
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${hits.length} roster-line bios to clear\n`);
  for (const h of hits.slice(0, 30)) console.log(`  • ${h.display_name}: ${String(h.biography).replace(/\s+/g, " ").slice(0, 80)}`);
  if (!DRY) {
    for (const h of hits) {
      await db.execute({ sql: "UPDATE corps_staff SET biography=NULL WHERE staff_id=?", args: [h.staff_id] });
      await db.execute({ sql: "DELETE FROM staff_profile_candidates WHERE staff_id=? AND kind='bio' AND value=?", args: [h.staff_id, h.biography] }).catch(() => {});
    }
    console.log(`\nCleared ${hits.length} roster-line bios.`);
  }
  process.exit(0);
};
main();
