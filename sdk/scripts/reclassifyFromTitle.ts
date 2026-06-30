// Title-first role_type: a person's TITLE is their stated role, so it should win
// over the section heading they were grouped under. "Brass Arranger" listed in a
// DESIGN section is brass, not design; "Front Ensemble Arranger" is percussion, not
// visual. This reclassifies role_type from normalizeCaption(title) whenever the
// title yields a confident caption that differs from the current (section-derived)
// role_type. Title-driven → no parser/section guessing (safe).
//
// Section stays the FALLBACK: when the title is caption-agnostic ("Caption Head",
// "Instructor", "Consultant") normalizeCaption(title)='other' and we leave the
// existing role_type alone.
//
// Dry-run default; --apply writes. Idempotent → safe in the reapplyStaffCuration chain.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';
import { normalizeCaption } from '../src/relational.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const rows = (await db.execute("SELECT assignment_id, title, role_type FROM corps_staff_assignments WHERE title IS NOT NULL AND title != ''")).rows as {
    assignment_id: string; title: string; role_type: string | null;
  }[];

  // Only override the section when the TITLE names a SPECIFIC performance caption.
  // A title that yields the GENERIC music/design/director buckets is LESS specific
  // than a real section (a bare "Arranger" in the Percussion section is percussion,
  // not generic "music") — there the section stays authoritative.
  const SPECIFIC = new Set(['brass', 'percussion', 'visual', 'guard', 'audio', 'drum-major']);
  const fixes: { id: string; title: string; from: string | null; to: string }[] = [];
  const byTransition = new Map<string, number>();
  for (const r of rows) {
    const cap = normalizeCaption(r.title);
    if (!SPECIFIC.has(cap) || cap === r.role_type) continue; // agnostic/generic title → keep section
    fixes.push({ id: r.assignment_id, title: r.title, from: r.role_type, to: cap });
    const k = `${r.role_type} → ${cap}`;
    byTransition.set(k, (byTransition.get(k) ?? 0) + 1);
  }

  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${fixes.length} assignment(s) reclassified from title\n`);
  console.log('Transitions (count):');
  for (const [k, n] of [...byTransition.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log('\nSample:');
  for (const f of fixes.slice(0, 20)) console.log(`  "${f.title}": ${f.from} → ${f.to}`);

  if (!DRY) {
    for (const f of fixes) await db.execute({ sql: 'UPDATE corps_staff_assignments SET role_type=? WHERE assignment_id=?', args: [f.to, f.id] });
    console.log(`\nApplied: ${fixes.length} role_type(s) reclassified from title.`);
  }
  process.exit(0);
};
main();
