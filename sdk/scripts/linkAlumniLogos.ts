// Give alumni/legacy corps the logo of their corresponding junior/parent corps.
//
// Alumni units ("Phantom Regiment Alumni Corps", "Colts Alumni Corps") rarely
// have their own logo. This strips the alumni/legacy tokens from the name and,
// when exactly one non-alumni corps with a logo normalizes to the same name,
// copies that corps's logo onto the alumni record. Confident exact matches only —
// ambiguous cases (e.g. "CT Alumni") are skipped and reported.
//
// Dry-run by default; pass --apply to write. Idempotent.

import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const scriptPath = fileURLToPath(import.meta.url);
const sdkDir = path.resolve(path.dirname(scriptPath), '..');
const db = createClient({ url: `file:${path.resolve(sdkDir, 'dci-relational.db')}` });

// Drop alumni/legacy + generic corps tokens, then strip to alphanumerics. The
// alumni-specific tokens are what differentiate a unit from its parent.
const STRIP_TOKENS = [
  'alumni',
  'alumnae',
  'legacy',
  'senior',
  'association',
  'ensemble',
  'the',
  'and',
  'drum',
  'bugle',
  'corps',
];
const normalize = (name: string): string => {
  let s = name.toLowerCase();
  for (const t of STRIP_TOKENS) s = s.replace(new RegExp(`\\b${t}\\b`, 'g'), ' ');
  return s.replace(/[^a-z0-9]+/g, '');
};

const hasLogo = (v: string | null) => !!v && v.trim() !== '';

const main = async () => {
  await db.execute('PRAGMA busy_timeout = 5000');

  const all = (
    await db.execute(`
      SELECT c.corps_key, c.name, c.division_name, c.type, c.corps_logo,
        CASE WHEN (c.division_name IS NULL OR c.division_name = '')
          AND (
            EXISTS (SELECT 1 FROM domain_event_exclusion_patterns p
                    WHERE p.category = 'alumni' AND lower(c.name) LIKE p.pattern)
            OR lower(COALESCE(c.type, '')) LIKE '%alumni%'
          ) THEN 1 ELSE 0 END AS is_alumni
      FROM corps c
    `)
  ).rows as unknown as Array<{
    corps_key: string;
    name: string;
    corps_logo: string | null;
    is_alumni: number;
  }>;

  // Candidate parents: non-alumni corps that have a logo. Map normalized name ->
  // matching parents (keep only unambiguous single matches).
  const parents = new Map<string, Array<{ corps_key: string; name: string; logo: string }>>();
  for (const c of all) {
    if (c.is_alumni || !hasLogo(c.corps_logo)) continue;
    const key = normalize(c.name);
    if (!key) continue;
    const list = parents.get(key) ?? [];
    list.push({ corps_key: c.corps_key, name: c.name, logo: c.corps_logo! });
    parents.set(key, list);
  }

  const linked: string[] = [];
  const skipped: string[] = [];
  for (const a of all) {
    if (!a.is_alumni || hasLogo(a.corps_logo)) continue;
    const key = normalize(a.name);
    const matches = parents.get(key);
    if (!matches || matches.length === 0) {
      skipped.push(`${a.name}  (no parent match for «${key}»)`);
      continue;
    }
    if (matches.length > 1) {
      skipped.push(`${a.name}  (ambiguous: ${matches.map((m) => m.name).join(', ')})`);
      continue;
    }
    const parent = matches[0]!;
    linked.push(`${a.name}  ←  ${parent.name}  (${parent.logo})`);
    if (APPLY) {
      await db.execute({
        sql: 'UPDATE corps SET corps_logo = ? WHERE corps_key = ?',
        args: [parent.logo, a.corps_key],
      });
    }
  }

  console.log(`\nLinked (${linked.length}):`);
  for (const l of linked) console.log(`  ✓ ${l}`);
  console.log(`\nSkipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  – ${s}`);
  console.log(`\n${APPLY ? '✅ applied' : 'Dry-run only — re-run with --apply to write.'}`);
  db.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
