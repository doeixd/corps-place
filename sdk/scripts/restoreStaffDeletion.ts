// Reverse staff deletions recorded by deletionArchive.ts. Replays the archived
// corps_staff row + its children back into the DB (INSERT OR IGNORE, so re-running
// is safe and won't clobber rows that already exist).
//
//   npx tsx scripts/restoreStaffDeletion.ts --staff-id <id>        # one entry
//   npx tsx scripts/restoreStaffDeletion.ts --script deleteJunkNames # all from a script
//   npx tsx scripts/restoreStaffDeletion.ts --since 2026-06-30       # all on/after a date
//   (add --apply to write; dry-run lists what would be restored)
import { createClient } from '@libsql/client';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';
import { DELETION_LOG } from './deletionArchive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const insertRow = async (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  await db.execute({
    sql: `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    args: cols.map((c) => row[c] as never),
  });
};

const main = async () => {
  if (!existsSync(DELETION_LOG)) { console.log(`No deletion log at ${DELETION_LOG}`); process.exit(0); }
  const wantStaff = arg('--staff-id'), wantScript = arg('--script'), wantSince = arg('--since');
  if (!wantStaff && !wantScript && !wantSince) { console.log('Specify --staff-id, --script, or --since.'); process.exit(1); }
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');

  const entries = readFileSync(DELETION_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
    ts: string; script: string; reason: string; staff_id: string; staff: Record<string, unknown>; children: Record<string, Record<string, unknown>[]>;
  });
  const sel = entries.filter((e) =>
    (wantStaff ? e.staff_id === wantStaff : true) && (wantScript ? e.script === wantScript : true) && (wantSince ? e.ts >= wantSince : true));

  console.log(`${DRY ? '(dry-run)' : 'RESTORING'} — ${sel.length} archived deletion(s)`);
  for (const e of sel) {
    const nChildren = Object.values(e.children).reduce((n, rows) => n + rows.length, 0);
    console.log(`  ${e.staff_id}  ("${e.staff.display_name}", from ${e.script} @ ${e.ts}) — ${nChildren} child row(s)`);
    if (!DRY) {
      await insertRow('corps_staff', e.staff);
      for (const [table, rows] of Object.entries(e.children)) for (const r of rows) await insertRow(table, r);
    }
  }
  if (!DRY) console.log(`\nRestored ${sel.length} staff row(s) + children.`);
  process.exit(0);
};
main();
