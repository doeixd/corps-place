// Fix person_ids polluted with a leading caption/section token even though the
// display_name is clean — e.g. /staff/electronics-erik-kosman (display "Erik
// Kosman"): one source staff_id had a slug like "...:electronics-erik-kosman"
// (the section header "Electronics" fused to the name during parsing) and that
// slug won the canonical person_id for the whole group, so the URL/grouping is
// wrong. Re-points person_id to slug(display_name) (merging into the clean id if
// it already exists). Records the merge in corps_staff_review.
//
// Detection (conservative): person_id ENDS WITH "-" + slug(display_name) AND the
// entire leading prefix is composed of known section/caption words. Dry-run default.
//   npx tsx scripts/fixPollutedPersonIds.ts          # dry-run
//   npx tsx scripts/fixPollutedPersonIds.ts --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRepoEnv } from './scriptEnv.js';
import { makeStaffPersonId } from '../src/relational.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const SECTION = new Set(
  ('electronics brass percussion visual guard color front ensemble battery pit drum major drumline ' +
    'music program design designer staff tour admin administration administrative operations sound audio ' +
    'synth ge general effect movement choreography tech instructor consultant director coordinator ' +
    'supervisor manager caption head asst assistant winds woodwinds horn drumming')
    .split(' ')
);

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');
  const keepSep = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) {
    keepSep.add(`${r.left_staff_id}|${r.right_staff_id}`);
  }

  const rows = (await db.execute('SELECT person_id, display_name, staff_id FROM corps_staff WHERE person_id IS NOT NULL')).rows as any[];
  const repName = new Map<string, string>();
  const staffByPid = new Map<string, string[]>();
  for (const r of rows) {
    const pid = String(r.person_id);
    if (!repName.has(pid) || String(r.display_name).length > repName.get(pid)!.length) repName.set(pid, String(r.display_name));
    (staffByPid.get(pid) ?? staffByPid.set(pid, []).get(pid)!).push(String(r.staff_id));
  }

  const fixes: { pid: string; clean: string; name: string; prefix: string }[] = [];
  for (const [pid, name] of repName) {
    const clean = makeStaffPersonId(name);
    if (!clean || clean.length < 4 || pid === clean || !pid.endsWith('-' + clean)) continue;
    const prefix = pid.slice(0, pid.length - clean.length - 1);
    const toks = prefix.split('-').filter(Boolean);
    if (toks.length === 0 || !toks.every((t) => SECTION.has(t))) continue;
    fixes.push({ pid, clean, name, prefix });
  }

  // SUFFIX pollution: a title/role phrase or a fused website tacked onto the END of
  // an otherwise clean person_id. Two detectors, both conservative:
  //  (i)  a maximal TRAILING run of admin/title words (display-independent → also
  //       catches nickname display names like "Ben Poethke"/benjamin-poethke-administrative);
  //  (ii) a fused website (an org/com/net token) after slug(display_name).
  // EXCLUDES numeric disambiguators (-2/-3 = genuinely different people) and suffixes
  // that are themselves a person_id (two-people concatenation → splitConcatenatedNames).
  const SUFFIX_ROLE = new Set(
    ('administrative administration operations operation historian svp sales donor relations lead chef ' +
      'merchandise hospitality emeritus advisor security logistics transportation volunteer events production ' +
      'sponsorship development marketing finance treasurer secretary president ' +
      'costuming costume props prop uniform uniforms color electronics ensemble drumline')
      .split(' ')
  );
  const allPids = new Set(repName.keys());
  for (const [pid, name] of repName) {
    if (fixes.some((f) => f.pid === pid)) continue;
    const toks = pid.split('-');
    if (toks.length < 3) continue;
    let clean: string | null = null, suffix = '';
    let end = toks.length;
    while (end > 2 && SUFFIX_ROLE.has(toks[end - 1])) end--;
    if (end < toks.length) { clean = toks.slice(0, end).join('-'); suffix = toks.slice(end).join('-'); }
    else {
      // Fused website: "<first>-<last>-<orgname>-org-<city>". Anchor on the org/com/net
      // token (not slug(display_name), which nickname-expands "Bill"→william and misses).
      // Names are ~always 2 tokens, so the first two are the person and the rest is junk.
      const idx = toks.findIndex((t) => /^(org|com|net)$/.test(t));
      if (idx >= 2 && toks.length >= 4) { clean = toks.slice(0, 2).join('-'); suffix = toks.slice(2).join('-'); }
    }
    if (!clean || clean === pid || allPids.has(suffix)) continue;
    fixes.push({ pid, clean, name, prefix: suffix });
  }

  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${fixes.length} polluted person_id(s)\n`);
  for (const f of fixes) console.log(`  ${f.pid}  →  ${f.clean}   ("${f.name}", stray prefix "${f.prefix}")`);

  if (!DRY) {
    const now = new Date().toISOString();
    for (const f of fixes) {
      // Re-point (merges into the clean id if it already exists, else renames).
      await db.execute({ sql: 'UPDATE corps_staff SET person_id=? WHERE person_id=?', args: [f.clean, f.pid] });
      await db.execute({
        sql: 'INSERT INTO corps_staff_review (review_id,left_staff_id,right_staff_id,same_person,confidence,action,rationale,resolved,decided_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?,1,?,?,?)',
        args: [randomUUID(), staffByPid.get(f.pid)![0], staffByPid.get(f.pid)![0], 'HIGH', 'merge', `section-word-polluted person_id "${f.pid}" → "${f.clean}"`, 'fix-polluted-pid', now, now],
      });
    }
    await db.execute('UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)');
    console.log(`\nApplied: ${fixes.length} person_id(s) de-polluted, facts re-synced.`);
  }
  process.exit(0);
};
main();
