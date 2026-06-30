// Merge person_ids that are the same person under a NICKNAME variant of the first name with the
// SAME surname: "Andy Putnam"/"Andrew Putnam", "Tony Aguilar"/"Anthony Aguilar", "Bob Scott"/
// "Robert Scott", "CJ Barrow"/"C.J. Barrow". Grouped by (canonical-first, last), accent/punct
// stripped. SAFETY: holds COMMON surnames (two-different-people risk) and respects keep-separate.
// Re-syncs staff_bio_facts.person_id. Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const NICK: Record<string, string> = { mike: "michael", mikey: "michael", rob: "robert", bob: "robert", bobby: "robert", jim: "james", jimmy: "james", tom: "thomas", tommy: "thomas", dan: "daniel", danny: "daniel", chris: "christopher", matt: "matthew", matty: "matthew", joe: "joseph", joey: "joseph", jon: "jonathan", jonny: "jonathan", tony: "anthony", steve: "steven", dave: "david", nick: "nicholas", andy: "andrew", drew: "andrew", ben: "benjamin", benny: "benjamin", sam: "samuel", will: "william", bill: "william", billy: "william", greg: "gregory", jeff: "jeffrey", rick: "richard", rich: "richard", ken: "kenneth", ron: "ronald", ed: "edward", eddie: "edward", pat: "patrick", alex: "alexander", nate: "nathan", nathaniel: "nathan", zach: "zachary", zack: "zachary", josh: "joshua", jake: "jacob", tim: "timothy", phil: "philip", gabe: "gabriel", dom: "dominic", vinny: "vincent", vince: "vincent", charlie: "charles", chuck: "charles", cathy: "catherine", kate: "katherine", katie: "katherine", liz: "elizabeth", beth: "elizabeth", abby: "abigail", maddie: "madison", sammy: "samuel" };
const COMMON = new Set("smith johnson williams jones brown davis miller wilson moore taylor anderson thomas jackson white harris martin garcia martinez rodriguez lewis lee walker hall allen young king wright lopez hill scott green adams baker gonzalez nelson carter mitchell perez roberts turner phillips campbell parker evans edwards collins reyes morales ortiz gomez".split(" "));
const canon = (f: string) => NICK[f.toLowerCase()] ?? f.toLowerCase();
// Strip apostrophes (JOIN, don't space) so "D'Antoine"→"dantoine" stays one token — otherwise the
// apostrophe becomes a space and the first token collapses to "D", colliding "D'Antoine"/"D'Angelo".
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const keepSep = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) { keepSep.add(String(r.left_staff_id)); keepSep.add(String(r.right_staff_id)); }
  const rows = (await db.execute("SELECT person_id, display_name, staff_id FROM corps_staff WHERE person_id IS NOT NULL")).rows as any[];
  const nameByPid = new Map<string, string>(), protectedPid = new Set<string>();
  for (const r of rows) { if (!nameByPid.has(String(r.person_id))) nameByPid.set(String(r.person_id), String(r.display_name)); if (keepSep.has(String(r.staff_id))) protectedPid.add(String(r.person_id)); }

  const byKey = new Map<string, Set<string>>();
  for (const [pid, name] of nameByPid) { const t = norm(name).split(" ").filter(Boolean); if (t.length < 2) continue; const key = `${canon(t[0]!)}|${t[t.length - 1]}`; (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(pid); }

  // Corps taught by a person_id — a shared corps between two same-canonical-name people is strong
  // same-person evidence (lets us safely merge even COMMON surnames).
  const corpsOf = async (pid: string) => new Set((await db.execute({ sql: "SELECT DISTINCT corps_key FROM corps_staff_assignments a JOIN corps_staff cs ON cs.staff_id=a.staff_id WHERE cs.person_id=?", args: [pid] })).rows.map((x: any) => x.corps_key));
  const merges: { canonical: string; from: string[]; names: string[] }[] = [];
  const held: string[] = [];
  for (const [key, pidSet] of byKey) {
    const pids = [...pidSet];
    if (pids.length < 2) continue;
    const names = [...new Set(pids.map((p) => nameByPid.get(p)!))];
    if (names.length < 2) continue; // identical names already handled by mergeByNameDefault
    if (pids.some((p) => protectedPid.has(p))) continue;
    const last = key.split("|")[1]!;
    if (COMMON.has(last)) {
      // Common surname → only merge if the people share a corps (else two-different-people risk).
      const sets = await Promise.all(pids.map(corpsOf));
      const overlap = sets.some((s, i) => sets.some((t, j) => i !== j && [...s].some((c) => t.has(c))));
      if (!overlap) { held.push(names.join(" | ")); continue; }
    }
    // Canonical = the FORMAL name (first token === the canonical first, e.g.
    // "jonathan" over the nickname "jon"), then alphabetical. (Was alphabetical
    // only, which wrongly made the nickname canonical — "jon" < "jonathan".)
    const canonFirst = key.split("|")[0]!;
    const firstOf = (p: string) => norm(nameByPid.get(p) ?? "").split(" ")[0] ?? "";
    const canonical = [...pids].sort(
      (a, b) => (firstOf(b) === canonFirst ? 1 : 0) - (firstOf(a) === canonFirst ? 1 : 0) || a.localeCompare(b)
    )[0]!;
    merges.push({ canonical, from: pids.filter((p) => p !== canonical), names });
  }

  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${merges.length} nickname merges, ${held.length} held (common surname)\n`);
  merges.slice(0, 30).forEach((m) => console.log(`  [${m.names.join(" | ")}] → ${m.canonical}`));
  console.log("\nHELD (common surname — review):"); held.slice(0, 12).forEach((h) => console.log(`  ${h}`));
  if (!DRY) {
    let rp = 0;
    for (const m of merges) { const cname = nameByPid.get(m.canonical)!; for (const p of m.from) { const res = await db.execute({ sql: "UPDATE corps_staff SET person_id=?, display_name=? WHERE person_id=?", args: [m.canonical, cname, p] }); rp += Number(res.rowsAffected ?? 0); } }
    await db.execute("UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)");
    console.log(`\nApplied: ${merges.length} merged (${rp} rows re-pointed).`);
  }
  process.exit(0);
};
main();
