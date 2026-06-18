// Merge-by-DEFAULT identity consolidation.
//
// Policy reversal: in the drum-corps world two DIFFERENT people sharing an exact full name is
// extremely rare, so the conservative "hold same-name cross-corps pairs for review" produced
// thousands of phantom duplicates (the same instructor split across the corps/seasons they
// taught — "Joe Hobbs" → 7 person_ids). This collapses every display name to ONE canonical
// person_id, EXCEPT pairs a human/web-research explicitly confirmed are different people
// (corps_staff_review.action='keep-separate'). --apply writes; default dry-run.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  // Pairs explicitly confirmed DIFFERENT people — never merge these names.
  const keepSeparate = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) {
    keepSeparate.add(String(r.left_staff_id)); keepSeparate.add(String(r.right_staff_id));
  }

  const rows = (await db.execute("SELECT staff_id, display_name, person_id FROM corps_staff WHERE person_id IS NOT NULL")).rows as any[];
  const byName = new Map<string, { pids: Set<string>; staffIds: string[]; protectedHit: boolean }>();
  for (const r of rows) {
    const nm = norm(r.display_name);
    const e = byName.get(nm) ?? { pids: new Set(), staffIds: [], protectedHit: false };
    e.pids.add(String(r.person_id)); e.staffIds.push(String(r.staff_id));
    if (keepSeparate.has(String(r.staff_id))) e.protectedHit = true;
    byName.set(nm, e);
  }

  let nameGroups = 0, rowsUpdated = 0, skippedProtected = 0;
  for (const [nm, e] of byName) {
    if (e.pids.size < 2) continue;
    if (e.protectedHit) { skippedProtected++; continue; } // a confirmed-distinct same-name set — leave it
    nameGroups++;
    const canonical = [...e.pids].sort()[0]!; // "joe-hobbs" sorts before "joe-hobbs-2"
    if (DRY) continue;
    const res = await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE lower(trim(display_name))=? AND person_id!=?", args: [canonical, nm, canonical] });
    rowsUpdated += Number(res.rowsAffected ?? 0);
  }
  if (!DRY) await db.execute("UPDATE corps_staff_review SET resolved=1, action=COALESCE(NULLIF(action,''),'merge'), decided_by='name-default' WHERE resolved=0 AND action!='keep-separate'");
  console.log(`${DRY ? "(dry-run)" : "APPLIED"}: ${nameGroups} multi-id names collapsed to one person_id${DRY ? "" : `, ${rowsUpdated} rows re-pointed`}; ${skippedProtected} protected (keep-separate) left split.`);
  process.exit(0);
};
main();
