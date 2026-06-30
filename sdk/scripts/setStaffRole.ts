// Durably correct a staff member's section/role for a corps (optionally a season)
// when the yearbook parser mis-assigned the section header — e.g. Stephanie
// Broadbelt was tagged Percussion/Sound but only taught Color Guard. Stores the
// correction in staff_role_overrides; reapplyStaffCuration re-applies it after every
// ingest, so a re-scrape can't revert it.
//
// staff_role_overrides(person_id, corps_key, season, role_type, title). season=''
// means ALL seasons at that corps.
//
//   npx tsx scripts/setStaffRole.ts --person stephanie-broadbelt --corps 001j000000iwx9waad --role guard --title "Color Guard" --apply
//   npx tsx scripts/setStaffRole.ts --person <id> --corps <key> --season 2016 --role visual --title "Visual" --apply
//   npx tsx scripts/setStaffRole.ts --person <id> --corps <key> --unset --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNSET = args.includes('--unset');
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const person = val('--person');
const corps = val('--corps');
const season = val('--season') ?? '';
const role = val('--role');
const title = val('--title');
const reason = val('--reason') ?? 'parser mis-section correction';
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const main = async () => {
  if (!person || !corps || (!UNSET && (!role || !title))) {
    console.error('Need --person --corps and (--role --title | --unset)');
    process.exit(1);
  }
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');
  await db.execute(
    'CREATE TABLE IF NOT EXISTS staff_role_overrides (person_id TEXT NOT NULL, corps_key TEXT NOT NULL, season TEXT NOT NULL DEFAULT \'\', role_type TEXT NOT NULL, title TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, PRIMARY KEY (person_id, corps_key, season))'
  );

  if (UNSET) {
    console.log(`${APPLY ? 'unset' : '(dry)'} role override ${person} × ${corps} × ${season || 'ALL'}`);
    if (APPLY) await db.execute({ sql: 'DELETE FROM staff_role_overrides WHERE person_id=? AND corps_key=? AND season=?', args: [person, corps, season] });
    process.exit(0);
  }

  console.log(`${APPLY ? 'APPLY' : '(dry-run)'} — ${person} × ${corps} × ${season || 'ALL seasons'} → ${role}/"${title}"`);
  if (!APPLY) { console.log('\nDRY-RUN — re-run with --apply.'); process.exit(0); }
  const now = new Date().toISOString();
  await db.execute({
    sql: 'INSERT INTO staff_role_overrides (person_id, corps_key, season, role_type, title, reason, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(person_id, corps_key, season) DO UPDATE SET role_type=excluded.role_type, title=excluded.title, reason=excluded.reason',
    args: [person, corps, season, role, title, reason, now],
  });
  const withSeason = season !== '';
  await db.execute({
    sql: `UPDATE corps_staff_assignments SET role_type = ?, title = ? WHERE corps_key = ? AND staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)${withSeason ? ' AND season = ?' : ''}`,
    args: withSeason ? [role, title, corps, person, season] : [role, title, corps, person],
  });
  console.log('\nApplied: role override recorded + assignments corrected. Re-enforced after each ingest by reapplyStaffCuration.ts.');
  process.exit(0);
};
main();
