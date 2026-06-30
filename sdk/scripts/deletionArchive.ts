// Reversible-deletion log for staff cleaners. Before any cleaner DELETEs a
// corps_staff row, it calls archiveStaffDeletion() to dump the full row PLUS all of
// its child rows (assignments / affiliations / bio_facts) as one JSON line to an
// append-only file. restoreStaffDeletion.ts replays those lines to undo a delete.
//
// The log lives at <repo>/data/deletions/staff-deletions.jsonl (one object per
// deleted staff_id). It is append-only and never rewritten, so it survives re-runs.
import type { Client } from '@libsql/client';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DELETION_LOG = resolve(__dirname, '..', '..', 'data', 'deletions', 'staff-deletions.jsonl');
const CHILD_TABLES = ['corps_staff_assignments', 'corps_staff_affiliations', 'staff_bio_facts'];

/** Archive each staff_id's full row + children to the deletion log. Call right BEFORE deleting. */
export const archiveStaffDeletion = async (
  db: Client,
  staffIds: string[],
  meta: { script: string; reason: string },
): Promise<void> => {
  if (!staffIds.length) return;
  mkdirSync(dirname(DELETION_LOG), { recursive: true });
  const ts = new Date().toISOString();
  for (const sid of staffIds) {
    const staff = (await db.execute({ sql: 'SELECT * FROM corps_staff WHERE staff_id = ?', args: [sid] })).rows;
    if (!staff.length) continue;
    const children: Record<string, unknown[]> = {};
    for (const t of CHILD_TABLES) {
      try { children[t] = (await db.execute({ sql: `SELECT * FROM ${t} WHERE staff_id = ?`, args: [sid] })).rows as unknown[]; }
      catch { children[t] = []; }
    }
    appendFileSync(DELETION_LOG, JSON.stringify({ ts, script: meta.script, reason: meta.reason, staff_id: sid, staff: staff[0], children }) + '\n');
  }
};
