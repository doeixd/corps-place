// Fix EXACTLY the people affected by the parser bug-fixes (section-heading theft +
// unbalanced-paren), by diffing the deterministic parser WITH vs WITHOUT the fixes
// on each page. A person whose section CHANGES between legacy and fixed was a
// victim of one of those bugs → correct their role to the fixed verdict.
//
// This is precise: residual parser quirks (present in BOTH versions) and other
// sources (audio/medical from the website scraper, AI fallback) do NOT appear in
// the diff, so the noise that made a blanket re-derive unsafe is excluded. Only
// fixes where the corrected section is a SPECIFIC caption are applied.
//
// Dry-run default; --apply writes (then dedupeAssignments for collapsed dups).
import { createClient } from '@libsql/client';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';
import { extractYearbook } from '../src/yearbook/yearbookText.js';
import { isStaffRosterPage, parseProfileDeterministic } from '../src/yearbook/yearbookExtract.js';
import { buildCorpsResolver } from '../src/yearbook/mapCorps.js';
import { makeStaffPersonId, normalizeCaption } from '../src/relational.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const YB_DIR = process.env.YEARBOOK_DIR ?? resolve(SDK_DIR, '..', 'data', 'yearbook');
const SPECIFIC = new Set(['brass', 'percussion', 'visual', 'guard', 'audio', 'drum-major']);
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const parseLegacy = (text: string) => {
  process.env.YB_PARSER_LEGACY = '1';
  try { return parseProfileDeterministic(text); } finally { delete process.env.YB_PARSER_LEGACY; }
};
const roleFor = (m: { roles: string[]; section: string | null }, title: string | null) => {
  const capTitle = normalizeCaption(m.roles?.[0] ?? title ?? undefined);
  const capSec = normalizeCaption(m.section);
  return SPECIFIC.has(capTitle) ? capTitle : capSec !== 'other' ? capSec : capTitle;
};

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const resolver = await buildCorpsResolver(db);

  const affected = new Map<string, { roleType: string; title: string | null }>();
  const pdfs = readdirSync(YB_DIR).filter((n) => /\.pdf$/i.test(n) && !/\.ocr\.pdf$/i.test(n) && !/\.part\d+/i.test(n));
  for (const file of pdfs) {
    const season = file.match(/\b(20\d\d)\b/)?.[1];
    if (!season) continue;
    let ex;
    try { ex = await extractYearbook(resolve(YB_DIR, file), season); } catch { continue; }
    for (const page of ex.pages.filter(isStaffRosterPage)) {
      const fixed = parseProfileDeterministic(page.text);
      if (!fixed || fixed.staff.length < 8) continue;
      const legacy = parseLegacy(page.text);
      const legacySection = new Map<string, string | null>();
      for (const s of legacy?.staff ?? []) legacySection.set(s.name, s.section);
      let website = fixed.website;
      if (!website) {
        const mate = page.pageNumber % 2 === 0 ? 1 : -1;
        for (const off of [mate, -mate]) {
          const adj = ex.pages.find((pp) => pp.pageNumber === page.pageNumber + off);
          const d = adj?.text.match(/\b([a-z0-9][a-z0-9-]*\.(org|com|net))\b/i)?.[1]?.toLowerCase();
          if (d && !d.startsWith('dci.')) { website = d; break; }
        }
      }
      const match = resolver({ website, location: fixed.location });
      if (!match) continue;
      for (const m of fixed.staff) {
        const before = legacySection.get(m.name);
        if (before === m.section) continue; // unchanged by the fixes → not a victim
        const title = (m.roles && m.roles.length ? m.roles.join(' / ') : m.section) ?? null;
        const role = roleFor(m, title);
        if (!SPECIFIC.has(role)) continue; // only the caption-section bug
        const pid = makeStaffPersonId(m.name);
        if (!pid) continue;
        affected.set(`${match.corpsKey}:${pid}|${season}`, { roleType: role, title });
      }
    }
  }
  console.log(`${affected.size} (person×season) changed section due to the fixes.`);

  const rows = (await db.execute("SELECT assignment_id, staff_id, season, title, role_type FROM corps_staff_assignments WHERE notes LIKE 'yearbook%'")).rows as {
    assignment_id: string; staff_id: string; season: string | null; title: string | null; role_type: string | null;
  }[];
  const fixes: { row: (typeof rows)[number]; to: { roleType: string; title: string | null } }[] = [];
  const byTransition = new Map<string, number>();
  // Conservative: only the caption-section-absorption class — both the stored and
  // corrected roles are specific captions. Excludes cross-category tail
  // (director/audio/medical/admin → X) which needs individual judgment.
  const CAP4 = new Set(['brass', 'percussion', 'visual', 'guard']);
  for (const r of rows) {
    const c = affected.get(`${r.staff_id}|${r.season}`);
    if (!c || c.roleType === r.role_type) continue;
    if (!CAP4.has(r.role_type ?? '') || !CAP4.has(c.roleType)) continue;
    fixes.push({ row: r, to: c });
    byTransition.set(`${r.role_type} → ${c.roleType}`, (byTransition.get(`${r.role_type} → ${c.roleType}`) ?? 0) + 1);
  }

  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${fixes.length} DB row(s) to correct\n`);
  console.log('Transitions:');
  for (const [k, n] of [...byTransition.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log('\nSample:');
  for (const f of fixes.slice(0, 20)) console.log(`  ${f.row.staff_id} ${f.row.season}: ${f.row.role_type} → ${f.to.roleType}`);

  if (!DRY) {
    for (const f of fixes) await db.execute({ sql: 'UPDATE corps_staff_assignments SET role_type=?, title=? WHERE assignment_id=?', args: [f.to.roleType, f.to.title, f.row.assignment_id] });
    console.log(`\nApplied: ${fixes.length} rows corrected. Run dedupeAssignments.ts --apply next.`);
  }
  process.exit(0);
};
main();
