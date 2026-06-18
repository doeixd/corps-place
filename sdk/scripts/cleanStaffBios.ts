// Clean bio text artifacts (docs/staff-quality-plan.md data-quality).
//   1. Strip "Read More / Read Less / Read More Less / →" toggle text (Squarespace).
//   2. Strip a trailing CONTACT/FOOTER block — once an email, phone, or URL appears, the rest
//      is page footer that leaked into the bio (e.g. "…(608) 782-3219 info@bluestars.org");
//      truncate to the last sentence boundary before it.
// Cleans corps_staff.biography (the displayed value). Candidates keep their raw text as history.
// Dry-run default; --apply writes. Re-run mineBioFacts afterward for cleaner facts.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

// An explicit "E-Mail:" label, or an address (tolerating a stray space before @, as in
// "joseph.riordan @seattlecascades.org") — both mark a leaked contact footer.
const EMAIL = /\bE-?Mail:|[A-Za-z0-9._%+-]+\s?@\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i;
const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+\.\w+/i;
// Nav / footer phrases that mark the END of a real bio and the start of leaked page chrome.
const NAV = /Membership Interest Form|Mission Statement|Ethics & Compliance|River City Rhapsody|Donate Now|Privacy Policy|Terms of (?:Use|Service)|All Rights Reserved|Subscribe|Performing Arts for Youth|Photo cred(?:it|its)|Photos? by\b|Photos? courtesy|Learn [Mm]ore about\b/;

const cleanBio = (raw: string): string => {
  let s = raw.replace(/\s+/g, " ").trim();
  // Truncate at the first footer marker (contact info OR nav chrome), backing up to a sentence end.
  const idx = [EMAIL, PHONE, URL, NAV].map((re) => { const m = s.match(re); return m ? m.index! : -1; }).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (idx !== undefined && idx >= 0) {
    const head = s.slice(0, idx);
    const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    s = (lastStop > 40 ? head.slice(0, lastStop + 1) : head).trim();
  }
  // Strip Squarespace toggle text anywhere it appears.
  s = s.replace(/\s*(?:…|\.\.\.)?\s*Read\s+More(?:\s+Less)?\b\s*(?:→|»|>)?/gi, " ")
       .replace(/\s*Read\s+Less\b/gi, " ")
       .replace(/\s*[→»]\s*$/g, "")
       .replace(/\s+/g, " ")
       .replace(/[\s,;:–—-]+$/, "")
       .trim();
  return s;
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name, biography FROM corps_staff WHERE length(trim(coalesce(biography,'')))>=40")).rows as any[];
  const changes: { staff_id: string; before: string; after: string }[] = [];
  for (const r of rows) {
    const after = cleanBio(String(r.biography));
    if (after !== String(r.biography).replace(/\s+/g, " ").trim() && after.length >= 30) changes.push({ staff_id: r.staff_id, before: r.biography, after });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${changes.length} bios to clean\n`);
  for (const c of changes.slice(0, 10)) console.log(`• ${c.before.slice(-70).replace(/\s+/g, " ")}\n   → …${c.after.slice(-70)}\n   (${c.before.length}→${c.after.length} chars)`);
  if (!DRY) { for (const c of changes) await db.execute({ sql: "UPDATE corps_staff SET biography=? WHERE staff_id=?", args: [c.after, c.staff_id] }); console.log(`\nApplied ${changes.length} bio cleanups.`); }
  process.exit(0);
};
main();
