// Backfill corps.dcx_museum_url from DCX Museum corps list pages.
//
// Usage:
//   npx tsx scripts/backfillDcxMuseumLinks.ts            # dry-run
//   npx tsx scripts/backfillDcxMuseumLinks.ts --apply    # write unambiguous matches
//   npx tsx scripts/backfillDcxMuseumLinks.ts --db ./dci-relational.db
//
// The DCX lists include thousands of corps/bands and some duplicate names, so
// matching is intentionally conservative: normalized name or alias must map to
// exactly one local corps row and exactly one DCX row. Ambiguous/skipped rows are
// written to results/ for manual review.

import { createClient } from '@libsql/client';
import * as cheerio from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';

type CorpsRow = {
  corps_key: string;
  name: string;
  display_city: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  dcx_museum_url: string | null;
};

type AliasRow = {
  alias_name: string;
  canonical_name: string;
};

type DcxEntry = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  option: 'active' | 'inactive';
  url: string;
};

type MatchReport = {
  corps_key: string;
  name: string;
  dcxName: string;
  dcxId: string;
  url: string;
  current: string | null;
  action: 'insert' | 'unchanged';
};

const BASE_URL = 'https://www.dcxmuseum.org/';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbArgIdx = argv.indexOf('--db');
const DB_PATH = dbArgIdx >= 0 ? argv[dbArgIdx + 1] : './dci-relational.db';

const cleanText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const displayName = (value: string): string => {
  const withoutNotes = value.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const suffixThe = withoutNotes.match(/^(.+),\s*The$/i);
  return suffixThe ? `The ${suffixThe[1].trim()}` : withoutNotes;
};

const normalizeName = (value: string): string =>
  displayName(value)
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\band\b/g, '')
    .replace(/\bdrum\b/g, '')
    .replace(/\bbugle\b/g, '')
    .replace(/\bcorps\b/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '');

const normalizeLocation = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const localCity = (row: CorpsRow): string | null =>
  row.city ?? row.display_city?.split(',')[0]?.trim() ?? null;

const localState = (row: CorpsRow): string | null =>
  row.state ?? row.display_city?.match(/,\s*([A-Z]{2})(?:\b|,)/)?.[1] ?? null;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function fetchDcxList(option: DcxEntry['option']): Promise<DcxEntry[]> {
  const url = `${BASE_URL}index.cfm?roomid=102&view=corps&option=${option}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`DCX ${option} list failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  const entries: DcxEntry[] = [];

  $('a[href*="view=corpslist"][href*="corpsid="]').each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr('href') ?? '';
    const id = href.match(/corpsid=(\d+)/i)?.[1];
    if (!id) return;
    const row = anchor.closest('tr');
    const cells = row.find('td').toArray();
    const parentSort = $(cells[0]).attr('data-sort-value') ?? '';
    const rawName = cleanText(anchor.text()) || cleanText(parentSort);
    const name = displayName(rawName);
    if (!name) return;
    entries.push({
      id,
      name,
      city: cleanText($(cells[2]).text() || $(cells[2]).attr('data-sort-value') || '') || null,
      state: cleanText($(cells[3]).text() || $(cells[3]).attr('data-sort-value') || '') || null,
      country: cleanText($(cells[4]).text() || $(cells[4]).attr('data-sort-value') || '') || null,
      option,
      url: `${BASE_URL}index.cfm?view=corpslist&CorpsID=${id}`,
    });
  });

  return entries;
}

function addIndex<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function locationScore(row: CorpsRow, entry: DcxEntry): number {
  const cityMatch =
    normalizeLocation(localCity(row)) !== '' &&
    normalizeLocation(localCity(row)) === normalizeLocation(entry.city);
  const stateMatch =
    normalizeLocation(localState(row)) !== '' &&
    normalizeLocation(localState(row)) === normalizeLocation(entry.state);
  const countryMatch =
    normalizeLocation(row.country) !== '' &&
    normalizeLocation(row.country) === normalizeLocation(entry.country);

  return (cityMatch ? 4 : 0) + (stateMatch ? 2 : 0) + (countryMatch ? 1 : 0);
}

function chooseCandidate(row: CorpsRow, candidates: DcxEntry[]): DcxEntry | null {
  if (candidates.length === 1) return candidates[0];

  const exactDisplay = candidates.filter(
    (candidate) => displayName(candidate.name).toLowerCase() === displayName(row.name).toLowerCase()
  );
  const pool = exactDisplay.length > 0 ? exactDisplay : candidates;
  const scored = pool
    .map((candidate) => ({ candidate, score: locationScore(row, candidate) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 2) return null;
  const tied = scored.filter((entry) => entry.score === best.score);
  return tied.length === 1 ? best.candidate : null;
}

async function main() {
  const dbPath = path.resolve(process.cwd(), DB_PATH);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  const db = createClient({ url: `file:${dbPath}` });
  const tableInfo = await db.execute('PRAGMA table_info(corps)');
  const hasDcxMuseumUrl = tableInfo.rows.some((row) => String(row.name) === 'dcx_museum_url');
  if (!hasDcxMuseumUrl && APPLY) {
    await db.execute('ALTER TABLE corps ADD COLUMN dcx_museum_url TEXT');
  }
  const dcxMuseumSelect = hasDcxMuseumUrl || APPLY ? 'dcx_museum_url' : 'NULL AS dcx_museum_url';

  const [active, inactive] = await Promise.all([fetchDcxList('active'), fetchDcxList('inactive')]);
  const dcxEntries = [...active, ...inactive];
  const dcxByName = new Map<string, DcxEntry[]>();
  for (const entry of dcxEntries) {
    const key = normalizeName(entry.name);
    if (key) addIndex(dcxByName, key, entry);
  }

  const [corpsResult, aliasResult] = await Promise.all([
    db.execute(`
      SELECT corps_key, name, display_city, city, state, country, ${dcxMuseumSelect}
      FROM corps
      WHERE name IS NOT NULL AND length(trim(name)) > 0
    `),
    db.execute(`
      SELECT alias_name, canonical_name
      FROM corps_aliases
    `),
  ]);

  const corpsRows = corpsResult.rows as unknown as CorpsRow[];
  const localByName = new Map<string, CorpsRow[]>();
  for (const row of corpsRows) {
    const key = normalizeName(row.name);
    if (key) addIndex(localByName, key, row);
  }
  for (const alias of aliasResult.rows as unknown as AliasRow[]) {
    const aliasKey = normalizeName(alias.alias_name);
    const canonical = localByName.get(normalizeName(alias.canonical_name)) ?? [];
    if (!aliasKey || canonical.length !== 1) continue;
    addIndex(localByName, aliasKey, canonical[0]);
  }

  const matches: MatchReport[] = [];
  const ambiguous: Array<{ name: string; corps_key: string; dcx: DcxEntry[] }> = [];
  const missing: CorpsRow[] = [];

  for (const row of corpsRows) {
    const keys = new Set([normalizeName(row.name)]);
    for (const [aliasKey, locals] of localByName) {
      if (locals.some((local) => local.corps_key === row.corps_key)) keys.add(aliasKey);
    }

    const candidates = [...keys].flatMap((key) => dcxByName.get(key) ?? []);
    const uniqueCandidates = [...new Map(candidates.map((entry) => [entry.id, entry])).values()];
    if (uniqueCandidates.length === 0) {
      missing.push(row);
      continue;
    }
    const entry = chooseCandidate(row, uniqueCandidates);
    if (!entry) {
      ambiguous.push({ name: row.name, corps_key: row.corps_key, dcx: uniqueCandidates });
      continue;
    }
    matches.push({
      corps_key: row.corps_key,
      name: row.name,
      dcxName: entry.name,
      dcxId: entry.id,
      url: entry.url,
      current: row.dcx_museum_url,
      action: row.dcx_museum_url === entry.url ? 'unchanged' : 'insert',
    });
  }

  const changes = matches.filter((match) => match.action === 'insert');
  const reportDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `dcx-museum-links-${APPLY ? 'apply' : 'dryrun'}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        applied: APPLY,
        fetched: { active: active.length, inactive: inactive.length, total: dcxEntries.length },
        matched: matches.length,
        changes: changes.length,
        ambiguous: ambiguous.length,
        missing: missing.length,
        matches,
        ambiguous,
        missing,
      },
      null,
      2
    )
  );

  console.log(`\nDCX Museum link backfill ${APPLY ? '(APPLY)' : '(dry-run)'}`);
  console.log(`Fetched: ${active.length} active, ${inactive.length} inactive`);
  console.log(`Unambiguous matches: ${matches.length} (${changes.length} to update)`);
  console.log(`Ambiguous: ${ambiguous.length}; missing: ${missing.length}`);
  console.log(`Report written to ${reportPath}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to update corps.dcx_museum_url.');
    return;
  }

  await db.execute('BEGIN');
  try {
    for (const change of changes) {
      await db.execute({
        sql: `UPDATE corps SET ${quoteIdent('dcx_museum_url')} = ? WHERE corps_key = ?`,
        args: [change.url, change.corps_key],
      });
    }
    await db.execute('COMMIT');
  } catch (error) {
    await db.execute('ROLLBACK');
    throw error;
  }
  console.log(`Applied ${changes.length} DCX Museum links.`);
}

main().catch((error) => {
  console.error('[backfillDcxMuseumLinks] ERROR', error);
  process.exit(1);
});
