// Fix hyphen-spacing artifacts in staff display names:
//   • WORD-BREAK (PDF line-break hyphenation): "Noah Bul- son" → "Noah Bulson" (a lowercase
//     continuation after "- " means the hyphen split one word).
//   • HYPHENATED SURNAME with a stray space: "Emily Nelson- Garcia" → "Emily Nelson-Garcia"
//     (an Uppercase word after "- " is a real hyphenated surname; keep the hyphen, drop the space).
// Handles the space-before-hyphen variants too ("Sco -nyers"). Skips results that stop looking
// like a person. Dry-run default; --apply writes.
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
  raw
    .replace(/([A-Za-z])\s*-\s+([A-Z])/g, "$1-$2")   // "Nelson- Garcia" / "Holland - Albaugh" → "Nelson-Garcia"
    .replace(/([a-z])\s*-\s+([a-z])/g, "$1$2")        // "Bul- son" / "Sco -nyers" → "Bulson" (word-break join)
    .replace(/\s+/g, " ")
    .trim();

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name LIKE '%- %' OR display_name LIKE '% -%'")).rows as any[];
  const changes = rows
    .map((r) => ({ staff_id: r.staff_id, from: String(r.display_name), to: fix(String(r.display_name)) }))
    .filter((c) => c.to !== c.from && looksLikePersonName(c.to));
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${changes.length} names to fix\n`);
  changes.slice(0, 25).forEach((c) => console.log(`  "${c.from}" → "${c.to}"`));
  if (!DRY) { for (const c of changes) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [c.to, c.staff_id] }); console.log(`\nApplied ${changes.length} fixes.`); }
  process.exit(0);
};
main();
