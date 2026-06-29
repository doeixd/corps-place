// Re-apply staff curation after an ingest so manual improvements are DURABLE
// (STAFF_PROFILE_OWNERSHIP_PLAN durability). A re-scrape can re-split merged people
// (it re-creates new staff_ids for typo/nickname names) and re-create consolidated
// subgroup corps. This idempotent pass re-heals that. Run it AFTER ingest, BEFORE
// the read-model emit (seasonUpdateWorkflow does this automatically).
//
// What's already durable WITHOUT this (so we don't re-do it):
//   • person_id merges  — the corps_staff upsert never writes person_id, and
//     resolveStaffIdentity only assigns it when NULL, so existing merges survive.
//     (This pass still re-runs the mergers to catch NEWLY re-split rows.)
//   • suppressions      — the read-model builders exclude suppressed ids regardless.
//
// What this pass fixes (the overwrite/re-create gaps):
//   1. Corps consolidation — reassign assignments from an aliased corps_key
//      (corps_aliases) to its canonical corps, and drop the re-created alias corps
//      row. (e.g. "Bluecoats Rhythm IN BLUE" → Bluecoats.)
//   2. Re-split people — re-run the idempotent cleanup/merge chain so typo/OCR/
//      nickname splits introduced by the new scrape get re-collapsed.
//
// Dry-run by default; --apply writes.
//   npx tsx scripts/reapplyStaffCuration.ts            # dry-run
//   npx tsx scripts/reapplyStaffCuration.ts --apply
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}`;
const db = createClient({ url: DB_URL });

// The idempotent cleanup/merge chain (each is dry-run unless --apply). Order:
// dedup exact → OCR/subsumption dedup → collapsed/anagram person merges → nicknames.
const CHAIN = [
  'dedupeAssignments.ts',
  'cleanYearbookStaff.ts',
  'mergeFuzzyNameVariants.ts',
  'mergeNicknames.ts',
];

const main = async () => {
  if (APPLY) await db.execute('PRAGMA busy_timeout=15000');

  // ── 1. Corps aliases: reassign assignments from a re-created alias corps to its
  //     canonical corps, then drop the alias corps row. ─────────────────────────
  const aliases = (await db.execute('SELECT alias_key, alias_name, canonical_name FROM corps_aliases')).rows as {
    alias_key: string;
    alias_name: string;
    canonical_name: string;
  }[];
  let reassigned = 0;
  for (const a of aliases) {
    // Resolve canonical corps_key by name (exact, case-insensitive).
    const canon = (
      await db.execute({
        sql: 'SELECT corps_key FROM corps WHERE lower(name) = lower(?) LIMIT 1',
        args: [a.canonical_name],
      })
    ).rows[0] as { corps_key: string } | undefined;
    if (!canon || canon.corps_key === a.alias_key) continue;
    const n = (await db.execute({ sql: 'SELECT COUNT(*) n FROM corps_staff_assignments WHERE corps_key = ?', args: [a.alias_key] })).rows[0] as { n: number };
    const corpsRow = (await db.execute({ sql: 'SELECT 1 FROM corps WHERE corps_key = ?', args: [a.alias_key] })).rows.length;
    if (n.n === 0 && corpsRow === 0) continue; // nothing to do
    // SAFETY: only auto-consolidate a PURE staff-grouping corps (no competitive
    // record). A score/lineup-bearing alias is a real corps-key dup → defer to
    // mergeDuplicateCorpsKeys.ts (which merges scores with exact-dup safety). Don't
    // reassign/delete it here (a naive DELETE would orphan or FK-block on scores).
    const scores = (await db.execute({ sql: 'SELECT COUNT(*) n FROM corps_scores WHERE corps_key = ?', args: [a.alias_key] })).rows[0] as { n: number };
    const lineups = (await db.execute({ sql: 'SELECT COUNT(*) n FROM event_lineup_entries WHERE participant_id = ?', args: [a.alias_key] })).rows[0] as { n: number };
    if (scores.n > 0 || lineups.n > 0) {
      console.log(`  [corps-alias] SKIP ${a.alias_key} → ${a.canonical_name}: has ${scores.n} score(s)/${lineups.n} lineup(s) — run mergeDuplicateCorpsKeys.ts`);
      continue;
    }
    console.log(`  [corps-alias] ${a.alias_key} → ${canon.corps_key} (${a.canonical_name}): ${n.n} assignment(s)${corpsRow ? ' + drop corps row' : ''}`);
    if (APPLY) {
      await db.execute({ sql: 'UPDATE corps_staff_assignments SET corps_key = ? WHERE corps_key = ?', args: [canon.corps_key, a.alias_key] });
      await db.execute({ sql: 'UPDATE corps_staff_affiliations SET related_corps_key = ? WHERE related_corps_key = ?', args: [canon.corps_key, a.alias_key] });
      await db.execute({ sql: 'DELETE FROM corps WHERE corps_key = ?', args: [a.alias_key] });
      reassigned += n.n;
    }
  }

  // ── 2. Re-run the idempotent cleanup/merge chain (re-collapses re-split people). ─
  console.log(`\n${APPLY ? 'Running' : '(dry-run) would run'} cleanup/merge chain: ${CHAIN.join(', ')}`);
  if (APPLY) {
    for (const script of CHAIN) {
      console.log(`\n── ${script} ──`);
      execFileSync('npx', ['tsx', `scripts/${script}`, '--apply'], { cwd: SDK_DIR, stdio: 'inherit' });
    }
  }

  console.log(
    APPLY
      ? `\nApplied: ${reassigned} assignment(s) reassigned via corps_aliases; merge/cleanup chain re-run.`
      : '\nDRY-RUN — no changes. Re-run with --apply.'
  );
  process.exit(0);
};
main();
