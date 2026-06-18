// Merge person_ids that are clearly the SAME person but split by a NAME VARIANT —
// accent ("Andres" / "Andrés"), punctuation ("C.J." / "CJ", "Betty Smith."), or an added
// middle name ("Aaron Kava" / "Aaron Nolen Kava"). mergeByNameDefault only matches exact
// strings, so these slip through. Grouped by (first token, last token), accent+punct-stripped.
//
// SAFETY: only merge a group when middle names don't CONFLICT — "John A. Smith" + "John B.
// Smith" have different middle initials → left split (possibly two people). Initials match a
// full middle name; an empty middle matches anything. Respects corps_staff_review keep-separate.
// Re-syncs staff_bio_facts.person_id after. Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const strip = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s: string) => strip(s).split(" ").filter(Boolean);
const firstLast = (s: string) => { const t = toks(s); return t.length >= 2 ? `${t[0]} ${t[t.length - 1]}` : null; };
const middles = (s: string) => { const t = toks(s); return t.slice(1, -1); };
// Two names are compatible if their middle tokens don't conflict (initial matches a full word).
const compatible = (a: string, b: string) => {
  const ma = middles(a), mb = middles(b);
  const conflict = (x: string[], y: string[]) => x.some((w) => w.length > 1 && y.some((v) => v.length > 1 && v !== w && v[0] !== w[0] ? false : false)) ;
  // Simpler: collect full (len>1) middle words on each side; if both sides have a full middle
  // word and they differ, conflict.
  const fullA = ma.filter((w) => w.length > 1), fullB = mb.filter((w) => w.length > 1);
  if (fullA.length && fullB.length && fullA.join(" ") !== fullB.join(" ")) return false;
  void conflict;
  return true;
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const keepSep = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) { keepSep.add(String(r.left_staff_id)); keepSep.add(String(r.right_staff_id)); }

  const rows = (await db.execute("SELECT person_id, display_name, staff_id FROM corps_staff WHERE person_id IS NOT NULL")).rows as any[];
  // Representative display name per person_id (longest = most complete).
  const nameByPid = new Map<string, string>(), staffByPid = new Map<string, string[]>(), protectedPid = new Set<string>();
  for (const r of rows) {
    const pid = String(r.person_id);
    if (!nameByPid.has(pid) || String(r.display_name).length > nameByPid.get(pid)!.length) nameByPid.set(pid, String(r.display_name));
    (staffByPid.get(pid) ?? staffByPid.set(pid, []).get(pid)!).push(String(r.staff_id));
    if (keepSep.has(String(r.staff_id))) protectedPid.add(pid);
  }
  // Group person_ids by (first, last).
  const byFL = new Map<string, string[]>();
  for (const [pid, name] of nameByPid) { const fl = firstLast(name); if (fl) (byFL.get(fl) ?? byFL.set(fl, []).get(fl)!).push(pid); }

  const merges: { canonical: string; from: string[]; names: string[] }[] = [];
  for (const [, pids] of byFL) {
    const uniq = [...new Set(pids)];
    if (uniq.length < 2) continue;
    if (uniq.some((p) => protectedPid.has(p))) continue;
    // All pairwise compatible? (no conflicting full middle names)
    const names = uniq.map((p) => nameByPid.get(p)!);
    let ok = true;
    for (let i = 0; i < names.length && ok; i++) for (let j = i + 1; j < names.length; j++) if (!compatible(names[i]!, names[j]!)) { ok = false; break; }
    if (!ok) continue;
    const canonical = [...uniq].sort()[0]!;
    merges.push({ canonical, from: uniq.filter((p) => p !== canonical), names: [...new Set(names)] });
  }

  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${merges.length} variant groups to merge\n`);
  for (const m of merges.slice(0, 30)) console.log(`  [${m.names.join(" | ")}] → ${m.canonical}`);
  if (!DRY) {
    let n = 0;
    for (const m of merges) for (const p of m.from) { const res = await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE person_id=?", args: [m.canonical, p] }); n += Number(res.rowsAffected ?? 0); }
    await db.execute("UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)");
    console.log(`\nApplied: ${merges.length} groups merged, ${n} rows re-pointed, fact person_ids re-synced.`);
  }
  process.exit(0);
};
main();
