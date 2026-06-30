// Prune REDUNDANT weak assignment rows: within one (staff_id, corps_key, season), a
// person sometimes has a real role row AND a junk sibling for the same season —
//   • an empty/generic role_type='other' stub (note "dom/…": a low-confidence
//     dominant-caption backfill that duplicated an existing real assignment), or
//   • a row whose TITLE is a yearbook section-artifact ("Education", "Volunteer") —
//     the person was listed under both their caption section and a grouping section.
// e.g. Patrick Glenn 2026: brass "High Brass Technician" + other "" → drop the other;
//      2019: brass "Brass" + brass "Education" → drop the Education row.
//
// Rule (conservative): drop a WEAK row ONLY when the same (staff,corps,season) group
// also contains a STRONG anchor (specific caption role_type + a real, non-generic
// title). Weak-only groups are left untouched (we never strip a season's sole record).
// Unlike dedupeAssignments (exact-duplicate collapse) this removes near-dup noise.
//
// Pruned rows are archived to data/deletions/pruned-assignments.jsonl for reversal.
// Dry-run default; --apply writes. Idempotent → safe in the reapplyStaffCuration chain.
import { createClient } from '@libsql/client';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });
const ARCHIVE = resolve(SDK_DIR, '..', 'data', 'deletions', 'pruned-assignments.jsonl');

// Generic section/category "titles" that are not real job titles.
const GENERIC_TITLE = new Set(['', 'education', 'volunteer', 'volunteers', 'staff', 'team', 'member', 'members', 'section', 'performance', 'participant', 'performer', 'general']);
// Section-artifact titles that are redundant whenever a real-titled sibling exists,
// regardless of role_type (these come from a person appearing under two sections).
const ARTIFACT_TITLE = new Set(['education', 'volunteer', 'volunteers']);

const norm = (t: unknown) => String(t ?? '').trim().toLowerCase();

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const rows = (await db.execute('SELECT * FROM corps_staff_assignments WHERE season IS NOT NULL')).rows as Record<string, unknown>[];
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = `${r.staff_id}|${r.corps_key}|${r.season}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const isWeak = (r: Record<string, unknown>) => {
    const rt = norm(r.role_type), t = norm(r.title);
    if ((rt === '' || rt === 'other') && GENERIC_TITLE.has(t)) return true; // empty/generic 'other' stub
    if (ARTIFACT_TITLE.has(t)) return true; // section-artifact title
    return false;
  };
  const isStrong = (r: Record<string, unknown>) => {
    const rt = norm(r.role_type), t = norm(r.title);
    return rt !== '' && rt !== 'other' && t !== '' && !GENERIC_TITLE.has(t) && !ARTIFACT_TITLE.has(t);
  };

  const prune: Record<string, unknown>[] = [];
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    if (!g.some(isStrong)) continue; // no real anchor → leave the group alone
    for (const r of g) if (isWeak(r)) prune.push(r);
  }

  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${prune.length} redundant weak row(s) to prune\n`);
  const byReason = new Map<string, number>();
  for (const r of prune) {
    const reason = norm(r.role_type) === 'other' && GENERIC_TITLE.has(norm(r.title)) && !ARTIFACT_TITLE.has(norm(r.title)) ? `other:"${r.title ?? ''}"` : `artifact-title:"${r.title}"`;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log('\nSample:');
  for (const r of prune.slice(0, 15)) console.log(`  ${r.staff_id} ${r.season}: ${r.role_type}/"${r.title ?? ''}"`);

  if (!DRY && prune.length) {
    mkdirSync(dirname(ARCHIVE), { recursive: true });
    const ts = new Date().toISOString();
    for (const r of prune) appendFileSync(ARCHIVE, JSON.stringify({ ts, row: r }) + '\n');
    const ids = prune.map((r) => String(r.assignment_id));
    for (let i = 0; i < ids.length; i += 200) {
      const b = ids.slice(i, i + 200);
      await db.execute({ sql: `DELETE FROM corps_staff_assignments WHERE assignment_id IN (${b.map(() => '?').join(',')})`, args: b });
    }
    console.log(`\nPruned ${ids.length} rows (archived to ${ARCHIVE}).`);
  }
  process.exit(0);
};
main();
