// Remove duplicate staff assignments: rows identical in (staff_id, corps_key, season, title,
// role_type). These arise when a corps has multiple alias keys at ingest and the key is later
// canonicalized — leaving N identical rows that show the same role N times on the profile.
// Keeps the richest row per group (most non-null start/end/notes/links; tie → min assignment_id).
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

const richness = (r: any) => (r.start_year ? 1 : 0) + (r.end_year ? 1 : 0) + (r.notes ? 1 : 0) + (r.links_json && r.links_json !== "[]" ? 2 : 0);

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const groups = (await db.execute(
    `SELECT staff_id, corps_key, season, COALESCE(title,'') t, role_type, COUNT(*) c
       FROM corps_staff_assignments GROUP BY staff_id, corps_key, season, COALESCE(title,''), role_type HAVING c > 1`,
  )).rows as any[];
  let toDelete: string[] = [];
  for (const g of groups) {
    const rows = (await db.execute({
      sql: `SELECT assignment_id, start_year, end_year, notes, links_json FROM corps_staff_assignments
              WHERE staff_id=? AND corps_key=? AND season=? AND COALESCE(title,'')=? AND role_type=?`,
      args: [g.staff_id, g.corps_key, g.season, g.t, g.role_type],
    })).rows as any[];
    rows.sort((a, b) => richness(b) - richness(a) || String(a.assignment_id).localeCompare(String(b.assignment_id)));
    toDelete.push(...rows.slice(1).map((r) => String(r.assignment_id))); // keep rows[0] (richest)
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${groups.length} dup groups, ${toDelete.length} redundant assignment rows to delete`);
  if (!DRY) {
    for (let i = 0; i < toDelete.length; i += 200) {
      const batch = toDelete.slice(i, i + 200);
      await db.execute({ sql: `DELETE FROM corps_staff_assignments WHERE assignment_id IN (${batch.map(() => "?").join(",")})`, args: batch });
    }
    const tot = (await db.execute("SELECT count(*) n FROM corps_staff_assignments")).rows[0] as any;
    console.log(`Deleted ${toDelete.length}; assignments now ${tot.n}.`);
  }
  process.exit(0);
};
main();
