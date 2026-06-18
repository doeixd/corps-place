// Repair U+FFFD ("replacement character") mojibake in corps prose columns.
//
// Usage:
//   npx tsx scripts/repairCorpsMojibake.ts            # dry-run (default), prints diffs
//   npx tsx scripts/repairCorpsMojibake.ts --apply    # write fixes to the DB
//   npx tsx scripts/repairCorpsMojibake.ts --db ./dci-relational.db
//
// Background: an upstream bad decode replaced curly typography (apostrophes,
// smart quotes, em dashes) with the Unicode replacement character U+FFFD ('�',
// shown as "?"). The original bytes are gone, so this is a *heuristic* reconstruction
// driven by surrounding context, not a lossless decode. The damage is confined to
// the `corps.about` column today, but the repair scans every TEXT column and fixes
// any that contain U+FFFD using the same rules. A JSON report is written to results/.

import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const R = '�';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbArgIdx = argv.indexOf('--db');
const DB_PATH = dbArgIdx >= 0 ? argv[dbArgIdx + 1] : './dci-relational.db';

// Typography we reconstruct U+FFFD back into.
const APOS = '’'; // ’ right single quote / apostrophe
const LDQUO = '“'; // “
const RDQUO = '”'; // ”
const LSQUO = '‘'; // ‘
const RSQUO = '’'; // ’ (same glyph as APOS)
const EMDASH = '—'; // —

const isSpace = (ch: string) => ch === '' || /\s/.test(ch);

/**
 * Heuristically replace every U+FFFD in `text`. Strategy:
 *  1. Hardcoded short nicknames that were single-quoted ('A', '7R').
 *  2. Contraction/possessive apostrophe: U+FFFD directly before "s" (DCI’s, Iowa’s).
 *  3. Decade apostrophe: U+FFFD before a digit after a space ('90s, '00s).
 *  4. Spaced em dash: U+FFFD with whitespace on both sides ( — ).
 *  5. Remaining marks are quote delimiters or trailing possessives — resolved by a
 *     left-to-right pass that pairs an opening mark (space-then-mark) with the next
 *     closing mark, emitting matched double quotes; an unpaired trailing mark after
 *     a non-space is a possessive apostrophe; an unpaired opener is an em dash.
 */
function repair(text: string): string {
  let s = text;

  // 1. Known single-quoted short tokens.
  s = s.replaceAll(`${R}7R${R}`, `${LSQUO}7R${RSQUO}`);
  s = s.replaceAll(`${R}A${R}`, `${LSQUO}A${RSQUO}`);

  // 2. Contraction / possessive: mark immediately before a lowercase "s".
  s = s.replace(new RegExp(`(?<=[A-Za-z0-9])${R}(?=s)`, 'g'), APOS);

  // 3. Decade apostrophe: mark before a digit, preceded by whitespace.
  s = s.replace(new RegExp(`(?<=\\s)${R}(?=\\d)`, 'g'), APOS);

  // 4. Spaced em dash: whitespace on both sides.
  s = s.replace(new RegExp(`(?<=\\s)${R}(?=\\s)`, 'g'), EMDASH);

  if (!s.includes(R)) return s;

  // 5. Pair remaining marks as quotes; classify leftovers.
  const chars = [...s];
  const role = new Array<string>(chars.length).fill('');
  const stack: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== R) continue;
    const prev = i > 0 ? chars[i - 1] : '';
    const next = i < chars.length - 1 ? chars[i + 1] : '';
    const opensLikely = isSpace(prev) && !isSpace(next);
    const closesLikely = !isSpace(prev) && isSpace(next);
    if (opensLikely && !closesLikely) {
      stack.push(i);
    } else if (closesLikely) {
      const open = stack.pop();
      if (open !== undefined) {
        role[open] = 'open';
        role[i] = 'close';
      } else {
        role[i] = 'possessive';
      }
    } else {
      role[i] = 'dash'; // glued on both sides
    }
  }
  // Any opener never matched by a closer was an em dash, not a quote.
  for (const open of stack) role[open] = 'dash';

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== R) continue;
    chars[i] =
      role[i] === 'open'
        ? LDQUO
        : role[i] === 'close'
          ? RDQUO
          : role[i] === 'dash'
            ? EMDASH
            : APOS; // possessive / fallback
  }
  return chars.join('');
}

// --- discover TEXT columns and scan for U+FFFD --------------------------------

type Change = { corps_key: string; name: string; column: string; before: string; after: string };

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = createClient({ url: `file:${path.resolve(DB_PATH)}` });

  const tableInfo = await db.execute(`PRAGMA table_info(corps)`);
  const textCols = tableInfo.rows
    .map((row) => ({ name: String(row.name), type: String(row.type ?? '') }))
    .filter((c) => /char|clob|text/i.test(c.type) || c.type === '')
    .map((c) => c.name);

  const changes: Change[] = [];
  let unresolved = 0;

  for (const col of textCols) {
    const ident = quoteIdent(col);
    const rows = await db.execute({
      sql: `SELECT corps_key, name, ${ident} AS val FROM corps WHERE ${ident} LIKE ?`,
      args: [`%${R}%`],
    });
    for (const r of rows.rows) {
      const before = String(r.val);
      const after = repair(before);
      if (after === before) continue;
      if (after.includes(R)) unresolved++;
      changes.push({
        corps_key: String(r.corps_key),
        name: String(r.name),
        column: col,
        before,
        after,
      });
    }
  }

  console.log(`\nMojibake repair ${APPLY ? '(APPLY)' : '(dry-run)'} on ${DB_PATH}`);
  console.log(`Columns scanned: ${textCols.join(', ')}`);
  console.log(
    `Rows to fix: ${changes.length}  |  rows still containing U+FFFD after repair: ${unresolved}\n`,
  );

  for (const c of changes) {
    console.log(`• [${c.name}] (${c.column})`);
    // Show the first damaged region before, and the same region after.
    const bi = c.before.indexOf(R);
    console.log(`    before: …${c.before.slice(Math.max(0, bi - 30), bi + 30)}…`);
    // Align the "after" view to the same character offset region.
    console.log(`    after : …${c.after.slice(Math.max(0, bi - 30), bi + 30)}…`);
    if (c.after.includes(R)) console.log(`    ⚠ still contains U+FFFD`);
  }

  const reportDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `corps-mojibake-repair-${APPLY ? 'apply' : 'dryrun'}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ db: DB_PATH, applied: APPLY, unresolved, changes }, null, 2),
  );
  console.log(`\nReport written to ${reportPath}`);

  if (APPLY) {
    await db.execute('BEGIN');
    try {
      for (const c of changes) {
        await db.execute({
          sql: `UPDATE corps SET ${quoteIdent(c.column)} = ? WHERE corps_key = ?`,
          args: [c.after, c.corps_key],
        });
      }
      await db.execute('COMMIT');
    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }
    console.log(`\nApplied ${changes.length} fixes.`);
  } else {
    console.log(`\nDry-run only — re-run with --apply to write these ${changes.length} fixes.`);
  }

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
