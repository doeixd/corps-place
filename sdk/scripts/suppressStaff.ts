// Durable removal of a staff person ("delete the page and don't let it come back").
// Used for takedown/privacy requests AND as the data layer for owner/admin profile
// deletion (STAFF_PROFILE_OWNERSHIP_PLAN.md — durable delete).
//
// Two parts make it durable:
//   1. INSERT into `staff_suppressions` (person_id) — the read-model staff builders
//      EXCLUDE these (builders/staff.ts loadSuppressedPersonIds), so even if a later
//      yearbook re-scrape re-creates the relational row, the person never reappears
//      on the site.
//   2. DELETE the current relational rows (corps_staff_assignments via FK cascade,
//      staff_bio_facts, corps_staff) for immediate cleanup.
//
// Dry-run by default; --apply writes. After --apply, publish with
// scripts/refresh-prod-read-model.sh so the live read-model drops the person.
//
// Usage (from sdk/):
//   npx tsx scripts/suppressStaff.ts --person dane-holmes --reason "takedown request"
//   npx tsx scripts/suppressStaff.ts --person dane-holmes --reason "takedown request" --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const person = args.includes('--person') ? args[args.indexOf('--person') + 1] : undefined;
const reason =
  (args.includes('--reason') ? args[args.indexOf('--reason') + 1] : undefined) ?? 'removal request';

const db = createClient({
  url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}`,
});

const main = async () => {
  if (!person) {
    console.error('Missing --person <person_id>');
    process.exit(1);
  }
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');

  // What's there now (for the dry-run diff / confirmation).
  const staff = (
    await db.execute({ sql: 'SELECT staff_id, display_name FROM corps_staff WHERE person_id = ?', args: [person] })
  ).rows as { staff_id: string; display_name: string }[];
  const assignN = (
    await db.execute({
      sql: 'SELECT COUNT(*) n FROM corps_staff_assignments WHERE staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)',
      args: [person],
    })
  ).rows[0] as { n: number };
  const factN = (await db.execute({ sql: 'SELECT COUNT(*) n FROM staff_bio_facts WHERE person_id = ?', args: [person] }))
    .rows[0] as { n: number };

  console.log(`${APPLY ? 'APPLY' : '(dry-run)'} — suppress person_id="${person}" (reason: ${reason})`);
  console.log(`  staff rows: ${staff.length}${staff.length ? ` (${[...new Set(staff.map((s) => s.display_name))].join(', ')})` : ''}`);
  console.log(`  assignments: ${assignN.n}, bio_facts: ${factN.n}`);
  if (staff.length === 0) console.log('  (no current rows — suppression will still be recorded to block future re-ingest)');

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
    process.exit(0);
  }

  await db.execute(
    'CREATE TABLE IF NOT EXISTS staff_suppressions (person_id TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL)'
  );
  const now = new Date().toISOString();
  await db.execute({
    sql: 'INSERT INTO staff_suppressions (person_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET reason=excluded.reason',
    args: [person, reason, now],
  });
  // Delete current rows. FK ON DELETE CASCADE on corps_staff_assignments.staff_id
  // removes assignments when corps_staff goes; do facts + assignments explicitly too.
  await db.execute({
    sql: 'DELETE FROM corps_staff_assignments WHERE staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)',
    args: [person],
  });
  await db.execute({ sql: 'DELETE FROM staff_bio_facts WHERE person_id = ?', args: [person] });
  await db.execute({ sql: 'DELETE FROM corps_staff WHERE person_id = ?', args: [person] });

  console.log(`\nApplied: suppressed + removed "${person}". Publish with scripts/refresh-prod-read-model.sh.`);
  process.exit(0);
};
main();
