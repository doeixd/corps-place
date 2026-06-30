// Reduce role_type='other' by inferring the caption from the PERSON's own dominant
// caption — e.g. Donnie VanDoren ("Consultant" → other, but brass in every other
// assignment) → brass; Tom Aungst ("Ensemble Coordinator" → other, percussion
// elsewhere) → percussion.
//
// SAFE gates (avoid mislabeling genuine non-caption staff):
//   • Only fill an 'other' row whose TITLE is performance/instructional
//     (consultant/caption head/ensemble/arranger/tech/instructor/coordinator…) AND
//     NOT an admin/director/medical/tour word.
//   • Only when the person has a STRICT dominant caption among their OTHER
//     (already-classified) caption assignments (≥2 and strictly the most).
//   • Title text is preserved; only role_type changes.
// Dry-run default; --apply writes. Idempotent.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const CAPTION = new Set(['brass', 'percussion', 'visual', 'guard', 'audio']);
// Title must look performance/instructional to be fillable…
const INSTRUCTIONAL = /\b(consultant|caption\s*head|ensemble|arrang\w*|tech\w*|instructor|coordinator|supervisor|specialist|staff|educator|designer|caption)\b/i;
// …and must NOT be an admin/leadership/support role (those legitimately stay 'other').
const NON_CAPTION = /\b(director|executive|ceo|president|board|tour|housing|medical|health|nurse|train\w*|fitness|parent|chaperone|volunteer|treasurer|secretar\w*|administ\w*|operations?|food|merch\w*|equipment|truck|driver|chaplain|counsel\w*|program\s*coordinator|business|finance|hr|human|development|advancement)\b/i;

type Row = { assignment_id: string; person_id: string; season: string | null; title: string | null; role_type: string };

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const rows = (await db.execute(`
    SELECT a.assignment_id, s.person_id, a.season, a.title, a.role_type
    FROM corps_staff_assignments a JOIN corps_staff s ON a.staff_id = s.staff_id`)).rows as unknown as Row[];

  // Dominant caption per person (strict) among classified caption rows.
  const capCount = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!CAPTION.has(r.role_type)) continue;
    const m = capCount.get(r.person_id) ?? capCount.set(r.person_id, new Map()).get(r.person_id)!;
    m.set(r.role_type, (m.get(r.role_type) ?? 0) + 1);
  }
  const dominant = new Map<string, string>();
  for (const [pid, m] of capCount) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] >= 2 && (ranked.length < 2 || ranked[0][1] > ranked[1][1])) dominant.set(pid, ranked[0][0]);
  }

  const fixes: { id: string; to: string; title: string | null; pid: string }[] = [];
  for (const r of rows) {
    if (r.role_type !== 'other' || !r.title) continue;
    if (!INSTRUCTIONAL.test(r.title) || NON_CAPTION.test(r.title)) continue;
    const dom = dominant.get(r.person_id);
    if (dom) fixes.push({ id: r.assignment_id, to: dom, title: r.title, pid: r.person_id });
  }

  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${fixes.length} 'other' rows to fill from dominant caption\n`);
  for (const f of fixes.slice(0, 30)) console.log(`  ${f.pid}: "${f.title}" → ${f.to}`);
  if (fixes.length > 30) console.log(`  …and ${fixes.length - 30} more`);

  if (!DRY) {
    for (const f of fixes) await db.execute({ sql: 'UPDATE corps_staff_assignments SET role_type=? WHERE assignment_id=?', args: [f.to, f.id] });
    console.log(`\nApplied: ${fixes.length} 'other' role_types filled from dominant caption.`);
  }
  process.exit(0);
};
main();
