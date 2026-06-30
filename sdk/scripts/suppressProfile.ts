// Durable removal of a staff person OR judge ("delete the page and don't let it
// come back"). Takedown/privacy requests + data layer for owner/admin profile
// delete (STAFF_PROFILE_OWNERSHIP_PLAN.md §11b).
//
// Durable in two parts:
//   1. INSERT into staff_suppressions(person_id) / judge_suppressions(judge_id) —
//      the read-model builders EXCLUDE these (builders/{staff,judges}.ts), so a
//      later re-scrape can't resurrect the person on the site.
//   2. DELETE the current relational rows for immediate cleanup (FK cascades handle
//      assignments/scores; bio_facts deleted explicitly).
//
// Dry-run by default; --apply writes. After --apply, publish with
// scripts/refresh-prod-read-model.sh so the live read-model drops the entity.
//
// Usage (from sdk/):
//   npx tsx scripts/suppressProfile.ts --type staff --id dane-holmes --reason "takedown"
//   npx tsx scripts/suppressProfile.ts --type judge --id a-snipes-1 --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const type = (val('--type') ?? 'staff') as 'staff' | 'judge';
// --id is canonical; --person kept as an alias for the staff case.
const id = val('--id') ?? val('--person');
const reason = val('--reason') ?? 'removal request';

const db = createClient({
  url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}`,
});

const CFG = {
  staff: {
    table: 'staff_suppressions',
    idCol: 'person_id',
    countRows: 'SELECT COUNT(*) n FROM corps_staff WHERE person_id = ?',
    deletes: [
      'DELETE FROM corps_staff_assignments WHERE staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)',
      'DELETE FROM staff_bio_facts WHERE person_id = ?',
      'DELETE FROM corps_staff WHERE person_id = ?',
    ],
  },
  judge: {
    table: 'judge_suppressions',
    idCol: 'judge_id',
    countRows: 'SELECT COUNT(*) n FROM judges WHERE judge_id = ?',
    // judges FK-cascades to judge_assignments/scores/links/etc.; bio_facts explicit.
    deletes: [
      'DELETE FROM judge_bio_facts WHERE judge_id = ?',
      'DELETE FROM judges WHERE judge_id = ?',
    ],
  },
} as const;

const main = async () => {
  if (type !== 'staff' && type !== 'judge') {
    console.error('--type must be staff or judge');
    process.exit(1);
  }
  if (!id) {
    console.error('Missing --id <entity_id>');
    process.exit(1);
  }
  const cfg = CFG[type];
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');

  const present = (await db.execute({ sql: cfg.countRows, args: [id] })).rows[0] as { n: number };
  console.log(`${APPLY ? 'APPLY' : '(dry-run)'} — suppress ${type} "${id}" (reason: ${reason})`);
  console.log(`  current rows: ${present.n}`);
  if (present.n === 0)
    console.log('  (no current rows — suppression still recorded to block future re-ingest)');

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
    process.exit(0);
  }

  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${cfg.table} (${cfg.idCol} TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL)`
  );
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO ${cfg.table} (${cfg.idCol}, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(${cfg.idCol}) DO UPDATE SET reason=excluded.reason`,
    args: [id, reason, now],
  });
  for (const sql of cfg.deletes) await db.execute({ sql, args: [id] });

  console.log(`\nApplied: suppressed + removed ${type} "${id}". Publish with scripts/refresh-prod-read-model.sh.`);
  process.exit(0);
};
main();
