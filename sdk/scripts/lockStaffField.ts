// Lock a curated corps_staff field so a re-scrape can't overwrite it (closes the
// last durability gap — the upsert otherwise clobbers display_name/biography/
// photo_url/default_title with scraped values). The lock is RE-APPLIED after every
// ingest by reapplyStaffCuration.ts.
//
// Locks live in staff_field_locks(staff_id, field, value, reason, created_at).
// Lock by --staff <staff_id> (one row) or --person <person_id> (all their rows).
// If --value is omitted, the CURRENT value is locked (freeze as-is).
//
//   npx tsx scripts/lockStaffField.ts --person jonathan-vanderkolff --field display_name --value "Jonathan Vanderkolff" --apply
//   npx tsx scripts/lockStaffField.ts --staff <id> --field biography           # lock current bio
//   npx tsx scripts/lockStaffField.ts --person <id> --field photo_url --unlock --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNLOCK = args.includes('--unlock');
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const person = val('--person');
const staff = val('--staff');
const field = val('--field');
const value = val('--value');
const reason = val('--reason') ?? 'manual curation';

// Allowlist — field name is interpolated into SQL (an identifier can't be a param).
const LOCKABLE = ['display_name', 'biography', 'photo_url', 'default_title', 'given_name', 'family_name'];

const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const main = async () => {
  if (!field || !LOCKABLE.includes(field)) {
    console.error(`--field must be one of: ${LOCKABLE.join(', ')}`);
    process.exit(1);
  }
  if (!person && !staff) {
    console.error('Pass --person <person_id> or --staff <staff_id>');
    process.exit(1);
  }
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');
  await db.execute(
    'CREATE TABLE IF NOT EXISTS staff_field_locks (staff_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT, reason TEXT, created_at TEXT NOT NULL, PRIMARY KEY (staff_id, field))'
  );

  const staffIds = staff
    ? [staff]
    : ((await db.execute({ sql: 'SELECT staff_id FROM corps_staff WHERE person_id = ?', args: [person] })).rows as { staff_id: string }[]).map((r) => r.staff_id);
  if (staffIds.length === 0) {
    console.error('No matching corps_staff rows.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  for (const sid of staffIds) {
    if (UNLOCK) {
      console.log(`${APPLY ? 'unlock' : '(dry)'} ${sid}.${field}`);
      if (APPLY) await db.execute({ sql: 'DELETE FROM staff_field_locks WHERE staff_id = ? AND field = ?', args: [sid, field] });
      continue;
    }
    // Lock value = explicit --value, else the current stored value.
    const cur = value ?? ((await db.execute({ sql: `SELECT ${field} AS v FROM corps_staff WHERE staff_id = ?`, args: [sid] })).rows[0] as { v: string | null } | undefined)?.v ?? null;
    console.log(`${APPLY ? 'lock' : '(dry)'} ${sid}.${field} = ${JSON.stringify(cur)}`);
    if (APPLY) {
      await db.execute({
        sql: 'INSERT INTO staff_field_locks (staff_id, field, value, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(staff_id, field) DO UPDATE SET value=excluded.value, reason=excluded.reason',
        args: [sid, field, cur, reason, now],
      });
      // Set the value now too (so it's correct immediately, not just after next ingest).
      if (value !== undefined) await db.execute({ sql: `UPDATE corps_staff SET ${field} = ? WHERE staff_id = ?`, args: [value, sid] });
    }
  }
  console.log(APPLY ? `\nApplied: ${staffIds.length} ${field} lock(s). Re-applied after each ingest by reapplyStaffCuration.ts.` : '\nDRY-RUN — re-run with --apply.');
  process.exit(0);
};
main();
