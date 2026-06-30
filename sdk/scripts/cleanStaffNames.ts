// Tidy mis-extracted staff display names (docs/staff-quality-plan.md data-quality).
//
// Two fixes, both conservative:
//   1. STRIP a leaked role suffix so the record keeps just the person's name:
//        "Kevin Shah (Music Coordinator"  → "Kevin Shah"
//        "Bryan Burnham / Historian"      → "Bryan Burnham"
//      Only applied when the stripped tail is role-ish AND the remainder is a valid person
//      name — so real hyphenated names (Chris Ryan-Lawrence) are untouched.
//   2. DELETE pure role-label "names" that aren't people at all ("Composer & Arranger",
//      "Driver / Driver", "Conducting / Leadership") — they pollute the directory.
//
// After CLEANING, run mergeByNameDefault.ts so a de-suffixed name collapses into its existing
// clean twin (e.g. the real "Kevin Shah" row). Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { looksLikePersonName } from "../src/staffScraper.js";
import { archiveStaffDeletion } from "./deletionArchive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

// Role / department / generic words that are NOT part of a person's name. A "name" whose
// tokens are all (or mostly) these is junk; a trailing/leading run of these is a leaked role.
const ROLE_WORDS = new Set(
  ("coordinator director manager assistant intern driver designer design consultant consultants specialist specialists " +
   "staff admin administrative administration board member technician tech instructor wardrobe fleet equipment tour " +
   "operations operation medical nurse chaplain announcer webmaster photographer videographer content producer historian " +
   "entrepreneur arranger composer conducting leadership development event events battery brass percussion visual guard " +
   "volunteer hospitality merchandise merch sales sound audio electronics major caption program creative artistic music " +
   "business logistics production space supervisor updates here weekend package residential commuter opening two-day day " +
   "ensemble front general executive associate head section field scenic costume choreographer choreography movement " +
   "drill camp performance clinic strategy counsel warehouse vp svp sport science breast cancer phenom soundsport " +
   "transformation ent appointee counsel marketing finance cfo coo ceo president vice").split(/\s+/),
);
const ROLE_RE = new RegExp(`\\b(${[...ROLE_WORDS].join("|")})\\b`, "i");
const tok = (s: string) => s.replace(/[,;]/g, " ").split(/[\s.]+/).filter(Boolean);
const isRoleWord = (w: string) => ROLE_WORDS.has(w.toLowerCase().replace(/[^a-z-]/g, ""));
/** A real person name: looks like one AND no token is a role/generic word. */
const isPerson = (s: string) => looksLikePersonName(s) && tok(s).length >= 2 && !tok(s).some(isRoleWord);

/** Try to recover the person's name from a messy label; null if none. */
const extractPersonName = (raw: string): string | null => {
  let s = raw.trim();
  // Cut at an opening paren introducing a role ("Fred Smith (Music Coordinator").
  const p = s.search(/\s*\(/);
  if (p > 0) s = s.slice(0, p).trim();
  // Cut at a spaced separator, keeping whichever side is a person ("Bryan Burnham / Historian",
  // "Logistics & Production Lloyd Puckitt").
  const sep = s.match(/^(.+?)\s+[/&–—]\s+(.+)$/);
  if (sep) { const [, a, b] = sep; if (isPerson(a!) && !isPerson(b!)) s = a!.trim(); else if (isPerson(b!) && !isPerson(a!)) s = b!.trim(); }
  // Strip a trailing run of role words ("Mark Richardson Business Manager" → "Mark Richardson").
  let t = tok(s);
  while (t.length > 2 && isRoleWord(t[t.length - 1]!)) t.pop();
  // Strip a leading run of role words.
  while (t.length > 2 && isRoleWord(t[0]!)) t.shift();
  s = t.join(" ").replace(/[\s/&–—-]+$/, "").trim();
  return isPerson(s) ? s : null;
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const cleaned: { staff_id: string; from: string; to: string }[] = [];
  const junk: { staff_id: string; name: string }[] = [];
  for (const r of rows) {
    const name = String(r.display_name);
    if (isPerson(name) && !/[(/&]|–|—/.test(name)) continue; // already a clean person name
    const c = extractPersonName(name);
    if (c && c !== name) cleaned.push({ staff_id: r.staff_id, from: name, to: c });
    else if (!isPerson(name) && (ROLE_RE.test(name) || /[/&(]|–|—/.test(name))) junk.push({ staff_id: r.staff_id, name });
  }

  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${cleaned.length} names to clean, ${junk.length} junk rows to delete\n`);
  console.log("CLEAN:"); cleaned.slice(0, 40).forEach((c) => console.log(`  "${c.from}" → "${c.to}"`));
  console.log("\nDELETE (not a person):"); junk.slice(0, 40).forEach((j) => console.log(`  "${j.name}"`));

  if (!DRY) {
    for (const c of cleaned) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [c.to, c.staff_id] });
    await archiveStaffDeletion(db, junk.map((j) => String(j.staff_id)), { script: "cleanStaffNames", reason: "pure role-label non-person name" });
    for (const j of junk) await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [j.staff_id] }); // FK cascade clears assignments/links
    console.log(`\nApplied: cleaned ${cleaned.length}, deleted ${junk.length}. Re-run mergeByNameDefault.ts --apply to collapse de-suffixed twins.`);
  }
  process.exit(0);
};
main();
