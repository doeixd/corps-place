// Reclassify role_type='other' assignments whose TITLE clearly names a caption.
// Many assignments were ingested as role_type='other' because the section wasn't captured, yet
// their title IS the section ("Brass", "Color Guard", "Drum Majors", "Front Ensemble") — which
// normalizeCaption maps reliably. Genuinely-other titles ("Administration"→director,
// "Member at Large"→other) are handled by the same function. Improves the career-panel captions.
// Dry-run default; --apply writes. Re-emit afterward.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { normalizeCaption } from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT assignment_id, title FROM corps_staff_assignments WHERE role_type='other' AND title IS NOT NULL AND TRIM(title)!=''")).rows as any[];
  const updates: { id: string; cap: string }[] = [];
  const dist: Record<string, number> = {};
  for (const r of rows) {
    const cap = normalizeCaption(String(r.title));
    if (cap !== "other") { updates.push({ id: String(r.assignment_id), cap }); dist[cap] = (dist[cap] ?? 0) + 1; }
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${updates.length} of ${rows.length} 'other' assignments reclassify:`);
  console.log("  " + Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
  if (!DRY) {
    for (const u of updates) await db.execute({ sql: "UPDATE corps_staff_assignments SET role_type=? WHERE assignment_id=?", args: [u.cap, u.id] });
    console.log(`\nApplied ${updates.length} role_type reclassifications.`);
  }
  process.exit(0);
};
main();
