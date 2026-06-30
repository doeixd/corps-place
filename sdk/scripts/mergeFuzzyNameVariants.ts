// Merge person_ids split by a SURNAME TYPO — same first name, last name that's a
// letter-transposition/anagram of another ("LeBoeuf" / "LeBeouf", "Schmidt" /
// "Schmdit"). mergeNameVariants.ts groups by EXACT stripped (first,last) tokens, so
// these intra-token typos slip through. Generalizes the fix beyond any one person.
//
// SAFETY (conservative, to avoid merging two real people):
//   • AUTO-MERGE only when surnames are ANAGRAMS (same letter multiset, len ≥ 4) and
//     first names match — an anagram surname + same first name is almost always a typo.
//   • REPORT-ONLY for near-misses (edit distance ≤ 2 but not an anagram) — surfaced for
//     human review, never auto-merged.
//   • Respects corps_staff_review 'keep-separate'. Canonical = the spelling with more
//     staff rows (majority of sources), tie → more assignments, then alphabetical.
//   • Records each merge in corps_staff_review (action='merge', decided_by='fuzzy-merge')
//     so the decision is durable + auditable. Re-points person_id + display_name +
//     re-syncs staff_bio_facts.person_id. Dry-run default; --apply writes.
//
// Usage (from sdk/):
//   npx tsx scripts/mergeFuzzyNameVariants.ts            # dry-run: anagram merges + review list
//   npx tsx scripts/mergeFuzzyNameVariants.ts --apply
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRepoEnv } from './scriptEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes('--apply');
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, 'dci-relational.db')}` });

const strip = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string) => strip(s).split(' ').filter(Boolean);
const sortLetters = (s: string) => [...s].sort().join('');
const lev = (a: string, b: string): number => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

type Pid = { pid: string; name: string; staffIds: string[]; first: string; last: string; assigns: number; collapsed: string };

const main = async () => {
  if (!DRY) await db.execute('PRAGMA busy_timeout=15000');

  const keepSep = new Set<string>();
  for (const r of (await db.execute("SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE action='keep-separate'")).rows as any[]) {
    keepSep.add(`${r.left_staff_id}|${r.right_staff_id}`);
    keepSep.add(`${r.right_staff_id}|${r.left_staff_id}`);
  }

  const rows = (await db.execute('SELECT person_id, display_name, staff_id FROM corps_staff WHERE person_id IS NOT NULL')).rows as any[];
  const byPid = new Map<string, Pid>();
  for (const r of rows) {
    const pid = String(r.person_id);
    const t = toks(String(r.display_name));
    if (t.length < 2) continue;
    const e = byPid.get(pid);
    if (!e) byPid.set(pid, { pid, name: String(r.display_name), staffIds: [String(r.staff_id)], first: t[0], last: t[t.length - 1], assigns: 0, collapsed: '' });
    else {
      e.staffIds.push(String(r.staff_id));
      if (String(r.display_name).length > e.name.length) e.name = String(r.display_name);
    }
  }
  for (const p of byPid.values()) {
    const c = (await db.execute({ sql: 'SELECT COUNT(*) n FROM corps_staff_assignments WHERE staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id=?)', args: [p.pid] })).rows[0] as any;
    p.assigns = Number(c.n ?? 0);
    p.collapsed = toks(p.name).join(''); // letters only — spaces/dashes removed
  }

  const list = [...byPid.values()];

  // ── Tier 0: collapsed full-name equality (OCR dash/space splits) ──────────
  // The strongest signal: two person_ids whose FULL names are identical once all
  // spaces/dashes/punctuation are removed ("Jonathan Vanderkol ff" === "Jonathan
  // Vanderkolff", "jon-athan ..." etc.). This is the dash/space-split class that
  // slips every token-based matcher (the OCR break invents a fake token). Auto-merge
  // — canonical = most rows, then fewest tokens (least-split), then shortest pid.
  const handled = new Set<string>();
  const collapseMerges: { canon: Pid; dup: Pid }[] = [];
  const byCollapsed = new Map<string, Pid[]>();
  for (const p of list) {
    if (p.collapsed.length < 6) continue; // avoid short-name coincidences
    (byCollapsed.get(p.collapsed) ?? byCollapsed.set(p.collapsed, []).get(p.collapsed)!).push(p);
  }
  for (const group of byCollapsed.values()) {
    if (group.length < 2) continue;
    const blocked = group.some((x, i) =>
      group.some((y, j) => i < j && x.staffIds.some((sa) => y.staffIds.some((sb) => keepSep.has(`${sa}|${sb}`))))
    );
    if (blocked) continue;
    const sorted = [...group].sort(
      (a, b) =>
        b.staffIds.length - a.staffIds.length ||
        toks(a.name).length - toks(b.name).length ||
        a.pid.length - b.pid.length ||
        a.pid.localeCompare(b.pid)
    );
    const canon = sorted[0];
    for (const dup of sorted.slice(1)) {
      collapseMerges.push({ canon, dup });
      handled.add(dup.pid);
      handled.add(canon.pid);
    }
  }
  const anagram: { canon: Pid; dup: Pid }[] = [];
  const review: { a: Pid; b: Pid; dist: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (handled.has(a.pid) || handled.has(b.pid)) continue; // already merged by tier 0
      if (a.first !== b.first || a.last === b.last || a.last.length < 4 || b.last.length < 4) continue;
      const key = [a.pid, b.pid].sort().join('|');
      if (seen.has(key)) continue;
      const blocked = a.staffIds.some((sa) => b.staffIds.some((sb) => keepSep.has(`${sa}|${sb}`)));
      if (blocked) continue;
      if (sortLetters(a.last) === sortLetters(b.last)) {
        seen.add(key);
        // Auto-merge ONLY with a majority spelling (one side has more source rows →
        // the minority is the typo). Equal counts (1-vs-1) are ambiguous (could be two
        // real surnames, e.g. Barcus/Brusca) → route to review, never auto-merge.
        if (a.staffIds.length === b.staffIds.length) {
          review.push({ a, b, dist: lev(a.last, b.last) });
        } else {
          const [canon, dup] = a.staffIds.length > b.staffIds.length ? [a, b] : [b, a];
          anagram.push({ canon, dup });
        }
      } else if (lev(a.last, b.last) <= 2) {
        review.push({ a, b, dist: lev(a.last, b.last) });
      }
    }

  const merges = [
    ...collapseMerges.map((m) => ({ ...m, reason: 'ocr-split / spacing' })),
    ...anagram.map((m) => ({ ...m, reason: 'anagram surname typo' })),
  ];
  console.log(`${DRY ? '(dry-run)' : 'APPLIED'} — ${collapseMerges.length} collapsed-name merges, ${anagram.length} anagram-surname merges, ${review.length} near-miss for review\n`);
  console.log('AUTO-MERGE:');
  for (const m of merges) console.log(`  [${m.reason}] "${m.dup.name}" (${m.dup.pid}, ${m.dup.staffIds.length} rows) → "${m.canon.name}" (${m.canon.pid}, ${m.canon.staffIds.length} rows)`);
  console.log('\nREVIEW (near-miss, NOT merged):');
  for (const r of review.slice(0, 25)) console.log(`  "${r.a.name}" ~ "${r.b.name}" (surname dist ${r.dist})`);
  if (review.length > 25) console.log(`  …and ${review.length - 25} more`);

  if (!DRY) {
    const now = new Date().toISOString();
    let repointed = 0;
    for (const m of merges) {
      await db.execute({ sql: 'UPDATE corps_staff SET person_id=?, display_name=? WHERE person_id=?', args: [m.canon.pid, m.canon.name, m.dup.pid] });
      repointed++;
      await db.execute({
        sql: 'INSERT INTO corps_staff_review (review_id,left_staff_id,right_staff_id,same_person,confidence,action,rationale,resolved,decided_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?,1,?,?,?)',
        args: [randomUUID(), m.canon.staffIds[0], m.dup.staffIds[0], 'HIGH', 'merge', `${m.reason}: "${m.dup.name}" → "${m.canon.name}"`, 'fuzzy-merge', now, now],
      });
    }
    // Re-sync mined facts to the new canonical person_id.
    await db.execute('UPDATE staff_bio_facts SET person_id=(SELECT person_id FROM corps_staff WHERE corps_staff.staff_id=staff_bio_facts.staff_id) WHERE staff_id IN (SELECT staff_id FROM corps_staff)');
    console.log(`\nApplied: ${repointed} person_id(s) merged, review rows recorded, facts re-synced.`);
  }
  process.exit(0);
};
main();
