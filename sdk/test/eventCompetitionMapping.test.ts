// Tests for event_to_competition mapping table.
//
// Run with: npx tsx test/eventCompetitionMapping.test.ts
//
// Tests:
// 1. Mapping table exists and has expected schema
// 2. Backfill matching logic (pure functions)
// 3. Resolution queries work correctly against the live DB

import { createClient } from '@libsql/client';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

const dbUrl = () =>
  process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(process.cwd(), 'dci-relational.db')}`;

// --- Pure matching logic tests (mirrors the backfill script) ---

const normalize = (s: string) => s.trim().toLowerCase();

interface EventRow {
  slug: string;
  name: string;
  event_name: string | null;
  start_date: string;
}

interface CompetitionRow {
  slug: string;
  event_name: string;
  date: string;
}

const matchByDateAndName = (
  event: EventRow,
  competitions: CompetitionRow[]
): CompetitionRow | null => {
  const eventDate = event.start_date.split('T')[0];
  const eventSeason = event.slug.split('-')[0];
  const eventName = normalize(event.event_name ?? event.name);

  // First try: exact date + name match (prefer same season)
  const sameSeasonMatches: CompetitionRow[] = [];
  const otherSeasonMatches: CompetitionRow[] = [];

  for (const comp of competitions) {
    const compDate = comp.date.split('T')[0];
    const compName = normalize(comp.event_name);
    const compSeason = comp.slug.split('-')[0];

    if (compDate === eventDate && compName === eventName) {
      if (compSeason === eventSeason) {
        sameSeasonMatches.push(comp);
      } else {
        otherSeasonMatches.push(comp);
      }
    }
  }

  if (sameSeasonMatches.length > 0) return sameSeasonMatches[0];
  if (otherSeasonMatches.length > 0) return otherSeasonMatches[0];

  // Second try: date match with partial name match
  for (const comp of competitions) {
    const compDate = comp.date.split('T')[0];
    const compName = normalize(comp.event_name);

    if (compDate === eventDate) {
      if (compName.includes(eventName) || eventName.includes(compName)) {
        return comp;
      }
      const eventCore = eventName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
      const compCore = compName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
      if (eventCore === compCore && eventCore.length > 10) {
        return comp;
      }
    }
  }

  return null;
};

console.log('--- Pure matcher: date + name matching ---');

const testEvent: EventRow = {
  slug: '2025-dci-all-age-world-championship-finals',
  name: 'DCI All-Age World Championship Finals',
  event_name: 'DCI All-Age World Championship Finals',
  start_date: '2025-08-09T00:00:00.000Z',
};

const testCompetitions: CompetitionRow[] = [
  {
    slug: '2025-dci-all-age-world-championship',
    event_name: 'DCI All-Age World Championship',
    date: '2025-08-09T00:00:00.000Z',
  },
  {
    slug: '2024-dci-all-age-world-championship',
    event_name: 'DCI All-Age World Championship',
    date: '2024-08-10T00:00:00.000Z',
  },
];

const match1 = matchByDateAndName(testEvent, testCompetitions);
assert(match1 !== null, 'All Age Finals matches a competition');
assert(
  match1?.slug === '2025-dci-all-age-world-championship',
  'All Age Finals matches the correct (same date) competition'
);

// Test same-season preference
const testEvent2: EventRow = {
  slug: '2025-dci-world-championship-finals',
  name: 'DCI World Championship Finals',
  event_name: 'DCI World Championship Finals',
  start_date: '2025-08-09T00:00:00.000Z',
};

const testCompetitions2: CompetitionRow[] = [
  {
    slug: '2025-dci-world-championship-finals',
    event_name: 'DCI World Championship Finals',
    date: '2025-08-09T00:00:00.000Z',
  },
  {
    slug: '2024-dci-world-championship-finals',
    event_name: 'DCI World Championship Finals',
    date: '2024-08-10T00:00:00.000Z',
  },
];

const match2 = matchByDateAndName(testEvent2, testCompetitions2);
assert(match2 !== null, 'World Finals matches a competition');
assert(
  match2?.slug === '2025-dci-world-championship-finals',
  'World Finals prefers same-season match'
);

// --- Live DB tests ---

console.log('\n--- Live DB: mapping table exists ---');

const db = createClient({ url: dbUrl() });

try {
  // Check table exists
  const tableCheck = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='event_to_competition'`,
    args: [],
  });
  assert(tableCheck.rows.length > 0, 'event_to_competition table exists');

  // Check schema
  const schemaCheck = await db.execute({
    sql: `PRAGMA table_info(event_to_competition)`,
    args: [],
  });
  const columns = schemaCheck.rows.map((r) => (r as any).name);
  assert(columns.includes('event_slug'), 'has event_slug column');
  assert(columns.includes('competition_slug'), 'has competition_slug column');
  assert(columns.includes('match_method'), 'has match_method column');

  // Check some known mappings
  console.log('\n--- Live DB: known mappings ---');

  const allAgeMapping = await db.execute({
    sql: `SELECT competition_slug FROM event_to_competition WHERE event_slug = '2025-dci-all-age-world-championship-finals'`,
    args: [],
  });
  assert(
    (allAgeMapping.rows[0] as any)?.competition_slug === '2025-dci-all-age-world-championship',
    'All Age Finals maps to correct competition'
  );

  const worldFinalsMapping = await db.execute({
    sql: `SELECT competition_slug FROM event_to_competition WHERE event_slug = '2025-dci-world-championship-finals'`,
    args: [],
  });
  assert(
    (worldFinalsMapping.rows[0] as any)?.competition_slug === '2025-dci-world-championship-finals',
    'World Finals maps correctly'
  );

  // Check total mapping count
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM event_to_competition`,
    args: [],
  });
  const count = (countResult.rows[0] as any).count;
  assert(count > 500, `has >500 mappings (got ${count})`);

  // Check resolution query works
  console.log('\n--- Live DB: resolution query ---');

  const resolveResult = await db.execute({
    sql: `
      SELECT COALESCE(
        (SELECT competition_slug FROM event_to_competition WHERE event_slug = ?),
        (SELECT slug FROM competitions WHERE slug = ?)
      ) AS competition_slug
    `,
    args: ['2025-dci-all-age-world-championship-finals', '2025-dci-all-age-world-championship-finals'],
  });
  assert(
    (resolveResult.rows[0] as any)?.competition_slug === '2025-dci-all-age-world-championship',
    'Resolution query returns correct competition slug'
  );

  // Check direct competition slug also works
  const directResolve = await db.execute({
    sql: `
      SELECT COALESCE(
        (SELECT competition_slug FROM event_to_competition WHERE event_slug = ?),
        (SELECT slug FROM competitions WHERE slug = ?)
      ) AS competition_slug
    `,
    args: ['2025-dci-world-championship-finals', '2025-dci-world-championship-finals'],
  });
  assert(
    (directResolve.rows[0] as any)?.competition_slug === '2025-dci-world-championship-finals',
    'Direct competition slug resolution works'
  );
} finally {
  db.close();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed > 0 ? 1 : 0;
