// Rejoin OCR/letter-spacing splits in names: a word broken into a capitalized stem + trailing
// lowercase fragment(s) — "J osh Brickey"→"Josh Brickey", "Debra Trafi cante"→"Debra Traficante",
// "Jennifer Bart o n"→"Jennifer Barton". Rule: a fully-lowercase token that is NOT a name particle
// (de/du/van/la/…) is a fragment → join it onto the previous token. Real particles & "St."/initials
// are preserved (they're capitalized or whitelisted). Dry-run default; --apply writes.
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

const PARTICLE = new Set(["de", "del", "dela", "da", "di", "du", "van", "von", "la", "le", "el", "den", "der", "ten", "ter", "of", "the", "y", "bin", "al", "dos", "das", "san", "santa", "st", "mac", "mc", "lo", "li"]);
// Join a lowercase fragment onto the previous token ONLY when that token is a short, INCOMPLETE
// stem (≤6 chars) — a real complete word ("Festivals", "Reflective", "Danielle"; ≥7) followed by a
// lowercase word is a SENTENCE, not an OCR split, so we leave it (don't smush "Festivals"+"in").
const fix = (raw: string): string => {
  const t = raw.trim().split(/\s+/);
  const out: string[] = [];
  for (const w of t) {
    const bare = w.toLowerCase().replace(/[^a-z]/g, "");
    const prev = out[out.length - 1];
    if (prev && prev.replace(/[^A-Za-z]/g, "").length <= 6 && /^[a-z]/.test(w) && !PARTICLE.has(bare) && /^[a-z'’.-]+$/.test(w)) {
      out[out.length - 1] = prev + w;
    } else out.push(w);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  // Candidates: a name with an interior space-separated lowercase token.
  // Words that mark a name as actually a sentence/headline — never rejoin those (they're junk).
  const SENTENCE_WORD = /\b(make|submit|launch|join|want|help|difference|donations?|interest|form|talented|young|beyond|audition|information|facebook|county|camden|heart|reflective|expressive|kickoff|festivals?|resides?|maverick|registration|out|donate|click)\b/i;
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name GLOB '* [a-z]*'")).rows as any[];
  const joins: { staff_id: string; from: string; to: string }[] = [];
  for (const r of rows) {
    const from = String(r.display_name);
    if (SENTENCE_WORD.test(from)) continue;
    const to = fix(from);
    if (to !== from && looksLikePersonName(to)) joins.push({ staff_id: r.staff_id, from, to });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${joins.length} OCR-split names to rejoin\n`);
  console.log("REJOIN:"); [...new Map(joins.map((c) => [c.from, c])).values()].slice(0, 35).forEach((c) => console.log(`  "${c.from}" → "${c.to}"`));
  if (!DRY) {
    for (const c of joins) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [c.to, c.staff_id] });
    console.log(`\nApplied ${joins.length} rejoins.`);
  }
  process.exit(0);
};
main();
