// Durably suppress a specific staff ASSIGNMENT (person × corps [× season]) so a
// re-scrape can't re-introduce a misattribution or a hiatus-season row. Closes the
// assignment-level curation gap (e.g. Michael Gaines: his "Vanguard Cadets" rows
// were really SCV, and SCV 2023 was a hiatus). reapplyStaffCuration deletes any
// matching rows after every ingest.
//
// Suppressions live in staff_assignment_suppressions(person_id, corps_key, season).
// season='' means ALL seasons for that person×corps.
//
//   npx tsx scripts/suppressAssignment.ts --person michael-gaines --corps 001j000000iwxakaa1 --reason "misattributed; really SCV" --apply
//   npx tsx scripts/suppressAssignment.ts --person michael-gaines --corps 001j000000h3xwcaav --season 2023 --reason "SCV hiatus" --apply
//   npx tsx scripts/suppressAssignment.ts --person <id> --corps <key> --unsuppress --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNSUP = args.includes('--unsuppress');
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const person = val('--person');
const corps = val('--corps');
const season = val('--season') ?? ''; // '' = all seasons
const reason = val('--reason') ?? 'curation';
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const delSql = (withSeason: boolean) =>
  `DELETE FROM corps_staff_assignments WHERE corps_key = ? AND staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)${withSeason ? ' AND season = ?' : ''}`;

const main = async () => {
  if (!person || !corps) {
    console.error('Pass --person <person_id> --corps <corps_key> [--season <s>]');
    process.exit(1);
  }
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');
  await db.execute(
    'CREATE TABLE IF NOT EXISTS staff_assignment_suppressions (person_id TEXT NOT NULL, corps_key TEXT NOT NULL, season TEXT NOT NULL DEFAULT \'\', reason TEXT, created_at TEXT NOT NULL, PRIMARY KEY (person_id, corps_key, season))'
  );

  if (UNSUP) {
    console.log(`${APPLY ? 'unsuppress' : '(dry)'} ${person} × ${corps} × ${season || 'ALL'}`);
    if (APPLY) await db.execute({ sql: 'DELETE FROM staff_assignment_suppressions WHERE person_id=? AND corps_key=? AND season=?', args: [person, corps, season] });
    process.exit(0);
  }

  // How many rows it currently matches (for the dry-run diff).
  const withSeason = season !== '';
  const cnt = (await db.execute({ sql: delSql(withSeason).replace('DELETE', 'SELECT COUNT(*) n').replace(/$/, ''), args: withSeason ? [corps, person, season] : [corps, person] }).catch(() => ({ rows: [{ n: '?' }] }) as any)).rows[0] as { n: number | string };
  console.log(`${APPLY ? 'APPLY' : '(dry-run)'} — suppress ${person} × ${corps} × ${season || 'ALL seasons'} (matches ${cnt.n} current row(s))`);

  if (!APPLY) {
    console.log('\nDRY-RUN — re-run with --apply.');
    process.exit(0);
  }
  const now = new Date().toISOString();
  await db.execute({
    sql: 'INSERT INTO staff_assignment_suppressions (person_id, corps_key, season, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(person_id, corps_key, season) DO UPDATE SET reason=excluded.reason',
    args: [person, corps, season, reason, now],
  });
  // Remove any current matches now too.
  await db.execute({ sql: delSql(withSeason), args: withSeason ? [corps, person, season] : [corps, person] });
  console.log(`\nApplied: suppression recorded + current matches removed. Re-enforced after each ingest by reapplyStaffCuration.ts.`);
  process.exit(0);
};
main();
