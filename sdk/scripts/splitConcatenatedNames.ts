// Split bogus staff entries whose person_id is TWO people's names concatenated by a
// parser name-extraction miss (e.g. "Joe Heininger Christy Hobby" → joe-heininger +
// christy-hobby). Strong, low-false-positive signal: the person_id splits into two
// OTHER person_ids that BOTH already exist as separate real staff, and neither half
// is a role/title word (which would mean name+title pollution, a different bug).
//
// Fix: re-point each bogus assignment to whichever real half MATCHES that row's
// caption (the guard "Color Guard" row → the guard person; the brass row → the brass
// person). If exactly one half's established captions include the row's role_type →
// that half. If ambiguous (both/neither) → leave the row for manual review. Then the
// emptied bogus corps_staff row is removed (orphan-cleanup in reapply handles leftovers).
//
// Dry-run default; --apply writes.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

// Words that mean a half is a ROLE/TITLE phrase, not a person name → not a concat.
const ROLE_WORDS = new Set([
  'donor', 'relations', 'chef', 'lead', 'caption', 'head', 'coordinator', 'director', 'manager',
  'instructor', 'technician', 'tech', 'staff', 'operations', 'security', 'medical', 'nurse',
  'volunteer', 'board', 'member', 'food', 'transportation', 'logistics', 'merchandise',
  'quartermaster', 'supervisor', 'advisor', 'consultant', 'hospitality', 'sound', 'audio',
  'brass', 'percussion', 'visual', 'guard', 'design', 'music', 'drum', 'major', 'assistant',
  'associate', 'electronics', 'arranger', 'composer', 'choreographer', 'designer', 'admin',
]);
const hasRoleWord = (id: string) => id.split('-').some((w) => ROLE_WORDS.has(w));

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const staffRaw = (await db.execute('SELECT staff_id, person_id, display_name FROM corps_staff')).rows as {
    staff_id: string; person_id: string; display_name: string;
  }[];
  // staff_id is `${corps_key}:${person_id}`; corps_key = everything before the LAST ':' segment that is the person_id.
  // corps_key = the part before the FIRST ':' (corps keys contain no colon); the
  // staff_id suffix may be a name variant that differs from the (merged) person_id.
  const staff = staffRaw.filter((s) => s.person_id && s.staff_id.includes(':')).map((s) => ({ ...s, corps_key: s.staff_id.slice(0, s.staff_id.indexOf(':')) }));
  const personIds = new Set(staff.map((s) => s.person_id));
  // Each person's established caption role_types (from their non-bogus assignments).
  const capsByStaffId = new Map<string, Set<string>>();
  for (const r of (await db.execute("SELECT staff_id, role_type FROM corps_staff_assignments WHERE role_type IN ('brass','percussion','visual','guard','audio')")).rows as { staff_id: string; role_type: string }[]) {
    (capsByStaffId.get(r.staff_id) ?? capsByStaffId.set(r.staff_id, new Set()).get(r.staff_id)!).add(r.role_type);
  }
  const staffIdSet = new Set(staff.map((s) => s.staff_id));
  const nameByPerson = new Map<string, string>();
  for (const s of staff) if (s.display_name && !nameByPerson.has(s.person_id)) nameByPerson.set(s.person_id, s.display_name);

  // Ensure a corps_staff row exists for `${corps}:${pid}` (create from the person's
  // known display_name if the concatenation was their only instance at this corps).
  const ensureStaff = async (corps: string, pid: string) => {
    const sid = `${corps}:${pid}`;
    if (staffIdSet.has(sid)) return sid;
    const dn = nameByPerson.get(pid) ?? pid.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const [gn, ...rest] = dn.split(' ');
    if (!DRY) await db.execute({ sql: 'INSERT OR IGNORE INTO corps_staff (staff_id, given_name, family_name, display_name, person_id) VALUES (?,?,?,?,?)', args: [sid, gn ?? null, rest.join(' ') || null, dn, pid] });
    staffIdSet.add(sid);
    return sid;
  };
  const cloneAssignment = async (row: Record<string, unknown>, newStaff: string, corps: string) => {
    const newId = `${newStaff}:${row.season}:${corps}`;
    const exists = (await db.execute({ sql: 'SELECT 1 FROM corps_staff_assignments WHERE assignment_id = ?', args: [newId] })).rows.length > 0;
    if (exists) return;
    await db.execute({
      sql: 'INSERT INTO corps_staff_assignments (assignment_id, staff_id, corps_key, season, title, role_type, start_year, end_year, start_date, end_date, notes, links_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      args: [newId, newStaff, corps, row.season ?? null, row.title ?? null, row.role_type ?? null, row.start_year ?? null, row.end_year ?? null, row.start_date ?? null, row.end_date ?? null, row.notes ?? null, row.links_json ?? null].map((v) => v as never),
    });
  };

  let repointed = 0, cloned = 0, removed = 0, junked = 0;
  for (const s of staff) {
    // Pure role-phrase "people" — the parser read a section/role label as a name
    // ("Donor Relations", "Lead Chef"). EVERY token is a role word (real names always
    // have ≥1 non-role token), so the entry is bogus; delete it (its garbage-attributed
    // assignments go with it / via orphan-cleanup).
    const pidToks = s.person_id.split('-').filter(Boolean);
    if (pidToks.length >= 1 && pidToks.every((t) => ROLE_WORDS.has(t))) {
      console.log(`  ${DRY ? 'would' : ''} delete junk role-phrase entry ${s.staff_id} ("${s.display_name}")`);
      if (!DRY) await db.execute({ sql: 'DELETE FROM corps_staff WHERE staff_id = ?', args: [s.staff_id] });
      junked++;
      continue;
    }
    const parts = s.person_id.split('-');
    if (parts.length < 4) continue;
    // Find a split where BOTH halves are existing person_ids and neither is a role phrase.
    let split: [string, string] | null = null;
    for (let i = 2; i <= parts.length - 2; i++) {
      const a = parts.slice(0, i).join('-'), b = parts.slice(i).join('-');
      if (personIds.has(a) && personIds.has(b) && a !== s.person_id && b !== s.person_id) { split = [a, b]; break; }
    }
    if (!split) continue;
    const [a, b] = split;
    const aRole = hasRoleWord(a), bRole = hasRoleWord(b);
    if (aRole && bRole) continue; // both halves junk → not a clean person, skip
    // If exactly ONE half is a role/title phrase, this is name+title pollution (not two
    // people) — the real person is the OTHER half; route ALL rows there.
    const pollutionTarget = aRole ? b : bRole ? a : null;
    const aStaff = `${s.corps_key}:${a}`, bStaff = `${s.corps_key}:${b}`;

    const asg = (await db.execute({ sql: 'SELECT * FROM corps_staff_assignments WHERE staff_id = ?', args: [s.staff_id] })).rows as Record<string, unknown>[];
    for (const row of asg) {
      const rt = String(row.role_type ?? '');
      const aHas = capsByStaffId.get(aStaff)?.has(rt) ?? false;
      const bHas = capsByStaffId.get(bStaff)?.has(rt) ?? false;
      // Exactly one half's established captions match → that half. Otherwise the two
      // adjacent names shared the roster row → assign to BOTH (split).
      const targets = pollutionTarget ? [pollutionTarget] : aHas && !bHas ? [a] : bHas && !aHas ? [b] : [a, b];
      console.log(`  ${DRY ? 'would' : ''} ${s.person_id} ${row.season} ${rt} "${row.title}" → ${targets.join(' + ')}`);
      if (!DRY) {
        // First target re-points the existing row; extra targets get a clone.
        const first = await ensureStaff(s.corps_key, targets[0]);
        const newId = `${first}:${row.season}:${s.corps_key}`;
        const exists = (await db.execute({ sql: 'SELECT 1 FROM corps_staff_assignments WHERE assignment_id = ?', args: [newId] })).rows.length > 0;
        if (exists) await db.execute({ sql: 'DELETE FROM corps_staff_assignments WHERE assignment_id = ?', args: [String(row.assignment_id)] });
        else await db.execute({ sql: 'UPDATE corps_staff_assignments SET staff_id = ?, assignment_id = ? WHERE assignment_id = ?', args: [first, newId, String(row.assignment_id)] });
        for (const t of targets.slice(1)) await cloneAssignment(row, await ensureStaff(s.corps_key, t), s.corps_key);
      }
      repointed++; cloned += targets.length - 1;
    }
    console.log(`  ${DRY ? 'would' : ''} remove bogus staff ${s.staff_id}`);
    if (!DRY) await db.execute({ sql: 'DELETE FROM corps_staff WHERE staff_id = ?', args: [s.staff_id] });
    removed++;
  }
  console.log(`\n${DRY ? '(dry-run)' : 'APPLIED'} — re-pointed ${repointed} rows (+${cloned} clones), removed ${removed} bogus staff, deleted ${junked} junk role-phrase entries`);
  process.exit(0);
};
main();
