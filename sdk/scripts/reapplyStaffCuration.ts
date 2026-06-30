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
  'pruneRedundantAssignments.ts', // drop weak same-season siblings (empty 'other', "Education" artifacts)
  'cleanYearbookStaff.ts',
  // ── display_name cleaners (idempotent; delete-capable ones archive to the deletion
  //    log for reversal via restoreStaffDeletion.ts). Run before merges so de-suffixed
  //    names collapse into their clean twins. ──────────────────────────────────────
  'fixOcrSplitNames.ts',
  'cleanStaffNames.ts',
  'stripCorpsSuffixNames.ts',
  'deleteJunkNames.ts',
  'cleanResidualNames.ts',
  'fixNameTypos.ts',
  'normalizeStaffNames.ts',
  // ── structural identity fixes ────────────────────────────────────────────────────
  'splitConcatenatedNames.ts', // two-people-as-one parser misses (re-home then drop the bogus entry)
  'fixPollutedPersonIds.ts',
  'mergeSuffixedNames.ts', // collapse -2/-3 disambiguation collisions into their base ONLY when captions match (else keep separate)
  'mergeFuzzyNameVariants.ts',
  'mergeNicknames.ts',
  'reclassifyFromTitle.ts', // title-first for specific captions (before the dominant fill)
  'fillOtherFromDominant.ts', // last — needs merges done so dominant caption is accurate
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

  // ── 1b. Enforce assignment suppressions (remove re-scraped misattributions /
  //     hiatus rows, e.g. Gaines' Vanguard-Cadets rows + SCV 2023). ───────────────
  let suppressed = 0;
  try {
    const sups = (await db.execute('SELECT person_id, corps_key, season FROM staff_assignment_suppressions')).rows as {
      person_id: string;
      corps_key: string;
      season: string;
    }[];
    for (const s of sups) {
      const withSeason = s.season !== '';
      const sql = `DELETE FROM corps_staff_assignments WHERE corps_key = ? AND staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)${withSeason ? ' AND season = ?' : ''}`;
      const args = withSeason ? [s.corps_key, s.person_id, s.season] : [s.corps_key, s.person_id];
      if (APPLY) {
        const res = await db.execute({ sql, args });
        const n = Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
        if (n > 0) console.log(`  [assignment-suppress] ${s.person_id} × ${s.corps_key} × ${s.season || 'ALL'}: removed ${n}`);
        suppressed += n;
      }
    }
  } catch {
    /* no staff_assignment_suppressions table yet */
  }

  // ── 1c. Enforce role overrides (fix parser mis-sectioned assignments, e.g.
  //     Stephanie Broadbelt tagged Percussion/Sound but only taught Color Guard). ──
  let roleFixed = 0;
  try {
    const ovs = (await db.execute('SELECT person_id, corps_key, season, role_type, title FROM staff_role_overrides')).rows as {
      person_id: string; corps_key: string; season: string; role_type: string; title: string;
    }[];
    for (const o of ovs) {
      const withSeason = o.season !== '';
      const sql = `UPDATE corps_staff_assignments SET role_type = ?, title = ? WHERE corps_key = ? AND staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)${withSeason ? ' AND season = ?' : ''}`;
      const a = withSeason ? [o.role_type, o.title, o.corps_key, o.person_id, o.season] : [o.role_type, o.title, o.corps_key, o.person_id];
      if (APPLY) {
        const res = await db.execute({ sql, args: a });
        const n = Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
        if (n > 0) console.log(`  [role-override] ${o.person_id} × ${o.corps_key} × ${o.season || 'ALL'} → ${o.role_type}: fixed ${n}`);
        roleFixed += n;
      }
    }
  } catch {
    /* no staff_role_overrides table yet */
  }

  // ── 1d. Hygiene: delete orphaned child rows (affiliations / bio_facts whose
  //     corps_staff parent was removed by a cleaner with FK cascade off). They're
  //     invisible (read-model joins via corps_staff) but shouldn't linger. ─────────
  if (APPLY) {
    for (const t of ['corps_staff_assignments', 'corps_staff_affiliations', 'staff_bio_facts']) {
      try {
        const res = await db.execute(`DELETE FROM ${t} WHERE staff_id NOT IN (SELECT staff_id FROM corps_staff)`);
        const n = Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
        if (n > 0) console.log(`  [orphan-cleanup] ${t}: removed ${n}`);
      } catch {
        /* table absent */
      }
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

  // ── 3. Re-apply field locks LAST (so curated display_name/bio/photo/title win
  //     over both the scrape AND the merge chain's normalization). ───────────────
  const LOCKABLE = new Set(['display_name', 'biography', 'photo_url', 'default_title', 'given_name', 'family_name']);
  let relocked = 0;
  try {
    const locks = (await db.execute('SELECT staff_id, field, value FROM staff_field_locks')).rows as {
      staff_id: string;
      field: string;
      value: string | null;
    }[];
    for (const l of locks) {
      if (!LOCKABLE.has(l.field)) continue; // defend the interpolated identifier
      const row = (await db.execute({ sql: `SELECT ${l.field} AS v FROM corps_staff WHERE staff_id = ?`, args: [l.staff_id] })).rows[0] as { v: string | null } | undefined;
      if (!row || row.v === l.value) continue; // gone or already correct
      console.log(`  [field-lock] restore ${l.staff_id}.${l.field}`);
      if (APPLY) {
        await db.execute({ sql: `UPDATE corps_staff SET ${l.field} = ? WHERE staff_id = ?`, args: [l.value, l.staff_id] });
        relocked++;
      }
    }
  } catch {
    /* no staff_field_locks table yet — nothing to restore */
  }

  console.log(
    APPLY
      ? `\nApplied: ${reassigned} reassigned via corps_aliases; ${suppressed} assignment(s) suppressed; ${roleFixed} role(s) corrected; merge/cleanup chain re-run; ${relocked} field-lock(s) restored.`
      : '\nDRY-RUN — no changes. Re-run with --apply.'
  );
  process.exit(0);
};
main();
