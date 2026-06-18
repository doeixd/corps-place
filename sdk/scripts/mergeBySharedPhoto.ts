// Merge person_ids that share the SAME real photo_url — a headshot belongs to one person, so a
// shared (non-placeholder) photo is decisive same-person evidence. Catches what name-matching
// can't: surname typos ("Morales"/"Moralis", "Gruen"/"Grue"), nicknames ("Pookie"/"Shaiyeed"),
// abbreviations ("Matt"/"Matthew"). Run cleanStaffPhotos.ts FIRST so placeholders (shared by many)
// are already cleared. Respects keep-separate; re-syncs staff_bio_facts.person_id. Dry-run default.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const keepSep = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) { keepSep.add(String(r.left_staff_id)); keepSep.add(String(r.right_staff_id)); }
  const protectedPid = new Set<string>();
  const rows = (await db.execute("SELECT staff_id, person_id, photo_url FROM corps_staff WHERE photo_url IS NOT NULL AND photo_url!=''")).rows as any[];
  const byPhoto = new Map<string, Set<string>>();
  const nameByPid = new Map<string, string>();
  for (const r of rows) {
    if (keepSep.has(String(r.staff_id))) protectedPid.add(String(r.person_id));
    (byPhoto.get(String(r.photo_url)) ?? byPhoto.set(String(r.photo_url), new Set()).get(String(r.photo_url))!).add(String(r.person_id));
  }
  for (const r of (await db.execute("SELECT person_id, display_name FROM corps_staff WHERE person_id IS NOT NULL")).rows as any[])
    if (!nameByPid.has(String(r.person_id))) nameByPid.set(String(r.person_id), String(r.display_name));

  // A real headshot can still be shared by 2 DIFFERENT people if it's actually a placeholder the
  // ≥3 clear missed (e.g. "Adam Merkes" + "Linda Duffy"). Guard: only merge people who share a
  // name token (first or last) — every true same-person variant does; coincidental sharers don't.
  const toks = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3));
  const shares = (a: string, b: string) => { const tb = toks(b); for (const w of toks(a)) if (tb.has(w)) return true; return false; };
  const merges: { canonical: string; from: string[] }[] = [];
  for (const [, pidSet] of byPhoto) {
    const pids = [...pidSet];
    if (pids.length < 2 || pids.some((p) => protectedPid.has(p))) continue;
    const canonical = [...pids].sort()[0]!;
    const canonName = nameByPid.get(canonical) ?? "";
    const from = pids.filter((p) => p !== canonical && shares(canonName, nameByPid.get(p) ?? ""));
    if (from.length) merges.push({ canonical, from });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${merges.length} shared-photo groups to merge\n`);
  for (const m of merges.slice(0, 20)) console.log(`  ${[m.canonical, ...m.from].map((p) => `"${nameByPid.get(p) ?? p}"`).join(" + ")} → ${m.canonical}`);
  if (!DRY) {
    let n = 0;
    for (const m of merges) for (const p of m.from) { const res = await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE person_id=?", args: [m.canonical, p] }); n += Number(res.rowsAffected ?? 0); }
    await db.execute("UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)");
    console.log(`\nApplied: ${merges.length} groups merged, ${n} rows re-pointed, facts re-synced.`);
  }
  process.exit(0);
};
main();
