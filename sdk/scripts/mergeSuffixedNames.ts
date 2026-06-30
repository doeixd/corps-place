// Merge numeric-disambiguation person_ids ("stephen-hall-2" → "stephen-hall") into
// their base ONLY WHEN they share a caption — the safe same-person signal. These
// suffixes come from makeStaffPersonId's collision handler (Mike/Michael, Steve/
// Stephen formalize to the same slug). Two same-named people at different corps with
// DIFFERENT captions are probably different people, so we keep those split.
//
// Decision per suffixed person_id S (base B = S without -N):
//   • no base person exists          → rename S → B (lone person, no conflict)
//   • base exists, captions overlap  → merge: S → B
//   • base exists, captions disjoint → keep S separate (no change)
//
// Dry-run default; --apply writes. Idempotent → safe in the reapplyStaffCuration chain.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const allPids = new Set((await db.execute('SELECT DISTINCT person_id FROM corps_staff WHERE person_id IS NOT NULL')).rows.map((r) => String(r.person_id)));
  // captions per person_id (specific role_types only — 'other' is not a caption signal)
  const caps = new Map<string, Set<string>>();
  for (const r of (await db.execute("SELECT s.person_id pid, a.role_type rt FROM corps_staff_assignments a JOIN corps_staff s ON a.staff_id=s.staff_id WHERE a.role_type IS NOT NULL AND a.role_type!='other'")).rows as { pid: string; rt: string }[]) {
    (caps.get(r.pid) ?? caps.set(r.pid, new Set()).get(r.pid)!).add(r.rt);
  }

  const suffixed = [...allPids].filter((p) => /-[0-9]+$/.test(p));
  const decisions: { pid: string; target: string; reason: string }[] = [];
  for (const pid of suffixed) {
    const base = pid.replace(/-[0-9]+$/, '');
    if (!base || base.length < 3) continue;
    if (!allPids.has(base)) { decisions.push({ pid, target: base, reason: 'lone rename (no base person)' }); continue; }
    const sc = caps.get(pid) ?? new Set(), bc = caps.get(base) ?? new Set();
    const shared = [...sc].filter((c) => bc.has(c));
    if (shared.length) decisions.push({ pid, target: base, reason: `merge (shared caption: ${shared.join(',')})` });
    else decisions.push({ pid, target: pid, reason: `keep separate (disjoint: [${[...sc]}] vs [${[...bc]}])` });
  }

  const acts = decisions.filter((d) => d.target !== d.pid);
  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${suffixed.length} suffixed; ${acts.length} to merge/rename, ${suffixed.length - acts.length} kept separate\n`);
  for (const d of decisions) console.log(`  ${d.pid} → ${d.target}   [${d.reason}]`);

  if (!DRY) {
    const now = new Date().toISOString();
    for (const d of acts) {
      const sid = String((await db.execute({ sql: 'SELECT staff_id FROM corps_staff WHERE person_id=? LIMIT 1', args: [d.pid] })).rows[0]?.staff_id ?? d.pid);
      await db.execute({ sql: 'UPDATE corps_staff SET person_id=? WHERE person_id=?', args: [d.target, d.pid] });
      await db.execute({
        sql: 'INSERT INTO corps_staff_review (review_id,left_staff_id,right_staff_id,same_person,confidence,action,rationale,resolved,decided_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?,1,?,?,?)',
        args: [randomUUID(), sid, sid, 'MEDIUM', 'merge', `suffixed "${d.pid}" → "${d.target}" by-caption (${d.reason}); reverse: set person_id back to "${d.pid}"`, 'merge-suffixed-names', now, now],
      });
    }
    await db.execute('UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)');
    console.log(`\nApplied ${acts.length} by-caption.`);
  }
  process.exit(0);
};
main();
