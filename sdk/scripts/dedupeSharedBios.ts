// An identical bio on multiple DISTINCT person_ids is one of two things:
//   • SAME person, unmerged (the sharers share a common name token — "Dan Fong"/"Dr Dan Fong",
//     "Daniel Allen"/"Dan Allen") → MERGE them (real bio kept).
//   • GENERIC text mis-assigned to different people (no common name token — an article/quote like
//     "Participants enjoyed the Annual Meeting…", or "A Santa Clara Vanguard staff member who has
//     joined Music City…") → CLEAR the bio from all of them (it's nobody's personal bio).
// Re-syncs staff_bio_facts.person_id after merges. Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const toks = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3));
const commonToken = (names: string[]) => { let inter: Set<string> | null = null; for (const n of names) { const t = toks(n); inter = inter === null ? t : new Set([...inter].filter((w) => t.has(w))); } return (inter?.size ?? 0) > 0; };

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const groups = (await db.execute("SELECT biography FROM corps_staff WHERE length(trim(biography))>=60 GROUP BY biography HAVING count(distinct person_id)>1")).rows as any[];
  const merges: { canonical: string; from: string[]; names: string[] }[] = [];
  const clears: { bio: string; names: string[] }[] = [];
  for (const g of groups) {
    const bio = String(g.biography);
    const rows = (await db.execute({ sql: "SELECT distinct person_id, display_name FROM corps_staff WHERE biography=?", args: [bio] })).rows as any[];
    const names = [...new Set(rows.map((r) => String(r.display_name)))];
    const pids = [...new Set(rows.map((r) => String(r.person_id)))];
    if (commonToken(names) && pids.length > 1) { const canonical = pids.sort()[0]!; merges.push({ canonical, from: pids.filter((p) => p !== canonical), names }); }
    else clears.push({ bio, names });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${merges.length} same-person merges, ${clears.length} generic bios to clear\n`);
  console.log("MERGE:"); merges.forEach((m) => console.log(`  [${m.names.join(" | ")}] → ${m.canonical}`));
  console.log("\nCLEAR (generic, not a personal bio):"); clears.forEach((c) => console.log(`  [${c.names.join(", ").slice(0, 50)}]: ${c.bio.slice(0, 60).replace(/\s+/g, " ")}`));
  if (!DRY) {
    let rp = 0;
    for (const m of merges) for (const p of m.from) { const res = await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE person_id=?", args: [m.canonical, p] }); rp += Number(res.rowsAffected ?? 0); }
    for (const c of clears) await db.execute({ sql: "UPDATE corps_staff SET biography=NULL WHERE biography=?", args: [c.bio] });
    await db.execute("UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)");
    console.log(`\nApplied: ${merges.length} merged (${rp} rows), ${clears.length} generic bios cleared.`);
  }
  process.exit(0);
};
main();
