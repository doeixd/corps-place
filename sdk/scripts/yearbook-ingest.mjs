// Standalone yearbook ingest using deterministic parser + raw libsql.
// Usage: node --import tsx scripts/yearbook-ingest.mjs --season 2019 [--apply]
// No Effect pipeline, no AI, no native bindings needed.
// The deterministic parser lives in src/yearbook/yearbookExtract.ts

import { createClient } from '@libsql/client';
import { resolve, basename } from 'path';
import { readdirSync, existsSync } from 'fs';
import { extractYearbook } from '../src/yearbook/yearbookText.js';
import { isProfilePage, parseProfileDeterministic } from '../src/yearbook/yearbookExtract.js';
import { buildCorpsResolver } from '../src/yearbook/mapCorps.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const seasonArg = args.indexOf('--season');
const season = seasonArg >= 0 ? args[seasonArg + 1] : String(new Date().getFullYear());

const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(process.cwd(), 'dci-relational.db')}`;
const YB_DIR = process.env.YEARBOOK_DIR ?? resolve(process.cwd(), '..', 'data', 'yearbook');

function yearbookPdf(year) {
  if (!existsSync(YB_DIR)) return null;
  const pdfs = readdirSync(YB_DIR).filter(
    n => n.toLowerCase().endsWith('.pdf') && n.includes(String(year))
  ).sort();
  const ocr = pdfs.find(n => /\.ocr\.pdf$/i.test(n));
  return ocr ? resolve(YB_DIR, ocr) : pdfs[0] ? resolve(YB_DIR, pdfs[0]) : null;
}

function makePersonId(name) {
  if (!name) return null;
  const deaccented = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const base = deaccented
    .replace(/[\u201C\u201D\u2018\u2019'"]\w+[\u201C\u201D\u2018\u2019'"]/g, ' ')
    .replace(/\s*\([^)]+\)\s*/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

(async () => {
  const pdf = yearbookPdf(season);
  if (!pdf) { console.error(`No PDF for ${season}`); process.exit(1); }

  console.log(`Season ${season}: ${basename(pdf)}`);
  const extract = await extractYearbook(pdf, season);
  const profiles = extract.pages.filter(isProfilePage);
  console.log(`  ${profiles.length} corps profiles`);

  const db = createClient({ url: DB_URL });
  const resolver = await buildCorpsResolver(db);

  let corpsMatched = 0, people = 0, unmatched = 0;

  for (const page of profiles) {
    const result = parseProfileDeterministic(page.text);
    if (!result || result.staff.length === 0) {
      unmatched++;
      console.log(`  unmatched: page ${page.pageNum}`);
      continue;
    }

    const match = resolver({ website: result.website, location: result.location });
    if (!match) {
      unmatched++;
      console.log(`  unmatched corps: ${result.website} / ${result.location} (${result.staff.length} staff)`);
      continue;
    }

    corpsMatched++;
    console.log(`  ${match.corpsKey}: ${result.staff.length} staff (${result.website})`);

    if (!apply) continue;

    for (const m of result.staff) {
      const name = (m.name ?? '').trim();
      const pid = makePersonId(name);
      if (!pid || name.length < 3) continue;

      const title = m.roles.length ? m.roles.join(' / ') : m.section ?? null;
      const staffId = `${match.corpsKey}:${pid}`;

      await db.execute({
        sql: `INSERT INTO corps_staff (staff_id, display_name, default_title, person_id, metadata_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(staff_id) DO UPDATE SET
                display_name = excluded.display_name,
                default_title = coalesce(excluded.default_title, corps_staff.default_title),
                metadata_json = excluded.metadata_json`,
        args: [staffId, name, title, pid,
          JSON.stringify({ source: 'yearbook', authoritative: true, yearbookFile: basename(pdf) })]
      });

      const assignmentId = `${staffId}:${season}:${match.corpsKey}`;
      await db.execute({
        sql: `INSERT INTO corps_staff_assignments (assignment_id, staff_id, corps_key, season, title, role_type, start_year, end_year, notes)
              VALUES (?, ?, ?, ?, ?, 'other', ?, ?, 'yearbook/authoritative')
              ON CONFLICT(assignment_id) DO UPDATE SET
                title = coalesce(excluded.title, corps_staff_assignments.title),
                notes = 'yearbook/authoritative'`,
        args: [assignmentId, staffId, match.corpsKey, season, title, parseInt(season), parseInt(season)]
      });

      people++;
    }
  }

  console.log(`\n${apply ? 'Applied' : 'Dry-run'}: ${corpsMatched} corps matched, ${unmatched} unmatched, ${people} people`);
  db.close();
})();
