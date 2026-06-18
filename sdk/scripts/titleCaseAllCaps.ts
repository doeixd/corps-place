// Title-case ALL-CAPS titles in corps_staff.default_title AND corps_staff_assignments.title
// ("BRASS" → "Brass", "DESIGN & PRODUCTION" → "Design & Production"). Skips acronyms/credential
// strings (every word ≤4 chars: "MS, LAT, ATC", "LPCC-S") and anything with a digit (zips/junk).
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
    .replace(/(^|[\s'’.\-/&,])([a-z])/g, (_, b, c) => b + c.toUpperCase())
    .replace(/(\S\s+)(And|Of|The|For|To|In|On|At|An|A)\b/g, (_, p, w) => p + w.toLowerCase());
// Case it only if it's real words: no digits, and at least one word ≥5 chars (so acronyms/
// credential lists are left as-is).
const shouldCase = (t: string) => {
  if (t !== t.toUpperCase() || !/[A-Z]/.test(t) || /\d/.test(t)) return false;
  return t.split(/[^A-Za-z]+/).filter(Boolean).some((w) => w.length >= 5);
};

const run = async (table: string, idCol: string, col: string) => {
  const rows = (await db.execute(`SELECT ${idCol} id, ${col} v FROM ${table} WHERE ${col} IS NOT NULL AND length(${col})>=4`)).rows as any[];
  const changes = rows.filter((r) => shouldCase(String(r.v))).map((r) => ({ id: r.id, from: String(r.v), to: titleCase(String(r.v)) })).filter((c) => c.to !== c.from);
  console.log(`\n${table}.${col}: ${changes.length} to title-case`);
  changes.slice(0, 10).forEach((c) => console.log(`  "${c.from}" → "${c.to}"`));
  if (!DRY) { for (const c of changes) await db.execute({ sql: `UPDATE ${table} SET ${col}=? WHERE ${idCol}=?`, args: [c.to, c.id] }); }
  return changes.length;
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const a = await run("corps_staff", "staff_id", "default_title");
  const b = await run("corps_staff_assignments", "assignment_id", "title");
  console.log(`\n${DRY ? "(dry-run)" : "APPLIED"} — ${a} default_titles + ${b} assignment titles.`);
  process.exit(0);
};
main();
