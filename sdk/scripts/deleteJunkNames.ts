// Delete staff rows whose display_name is clearly NOT a single person:
//   • MULTI-NAME: a non-abbreviation word ending in "." followed by another capitalized name —
//     "Jacob Rodriguez. Oscar Ban", "Sam Beck. Nathan Balley", "Jim Steinman. smith". (Spares
//     "Adam St. Jean", "Ben St. Clair", "Timothy S. Sexton" — "St."/single-initial are whitelisted.)
//   • SENTENCE/HEADLINE: contains marketing/headline words ("Make a Difference", "Festivals in
//     Cincinnati", "Submit an Interest Form") or ≥2 lowercase function words.
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

const ABBR = new Set(["st", "dr", "mr", "mrs", "ms", "jr", "sr", "ph", "mt", "ft", "ave", "inc", "co", "corp", "mlle", "mme", "rev", "fr", "prof", "hon"]);
// non-abbrev word + "." + space + Capital  =>  two names jammed together
const MULTINAME = /\b([A-Za-z]{2,})\.\s+[A-Za-z]/g;
const FUNCTION = /\b(in|a|an|to|and|on|by|at|for|with|of|the|its|about|into|your|our|we|you)\b/gi;
// Clear non-name junk words. NOTE: do NOT list real names — "Young"/"Berry" are surnames,
// "Maverick" a first name; their headlines are caught by other words ("…and TALENTED").
const SENTENCE_WORD = /\b(make|submit|launch|join|want|help|donations?|interest|talented|audition|kickoff|festivals?|resides?|registration|donate|click|ultimately|expressive|reflective|facebook|instagram|visit|reporting|sign-?up|difference|beyond|information|membership)\b/i;

const isMultiName = (n: string): boolean => {
  let m: RegExpExecArray | null; MULTINAME.lastIndex = 0;
  while ((m = MULTINAME.exec(n)) !== null) if (!ABBR.has(m[1]!.toLowerCase())) return true;
  return false;
};
const isSentence = (n: string): boolean => {
  if (SENTENCE_WORD.test(n)) return true;
  const fns = (n.match(FUNCTION) ?? []).length;
  return fns >= 2; // prose has multiple function words ("X in the Y", "make a difference")
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const dels = rows.filter((r) => isMultiName(String(r.display_name)) || isSentence(String(r.display_name)));
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${dels.length} junk-name rows to delete\n`);
  [...new Set(dels.map((d) => String(d.display_name)))].slice(0, 35).forEach((n) => console.log(`  "${n}"`));
  if (!DRY) { for (let i = 0; i < dels.length; i += 200) { const b = dels.slice(i, i + 200).map((d) => d.staff_id); await db.execute({ sql: `DELETE FROM corps_staff WHERE staff_id IN (${b.map(() => "?").join(",")})`, args: b }); } console.log(`\nDeleted ${dels.length}.`); }
  process.exit(0);
};
main();
