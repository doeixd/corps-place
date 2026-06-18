// Tests for lineup schedule-item classification.
//
// Run with: npx tsx test/lineupClassification.test.ts
//
// Two layers:
//   1. Pure matcher (isScheduleItem) against golden include/exclude name sets.
//   2. DB drift guard: the live `season_performing_corps` view must include the
//      real performers and exclude the schedule noise (requires the migration to
//      have been applied to dci-relational.db).

import { createClient } from '@libsql/client';
import {
  isScheduleItem,
  isNonCorpsName,
  isAlumniName,
  SCHEDULE_ITEM_PATTERNS,
} from '../src/lineupClassification.js';

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

// Agenda/venue rows that must classify as schedule noise.
const SCHEDULE_NOISE = [
  'Event Concludes',
  'Reserved Seating Takes Effect',
  'Club Access Opens to Premium Ticket Holders',
  'Competition Resumes',
  'Movie Theater Cinecast',
  'Joint Performance',
  'Loge and Terrace Levels Open',
  'DCI World Championships Semifinals Begins',
  'All-Age World Championships Prelims',
  'All-Age Class Finals Begins',
  'World Championship Finals Begins',
];

// Real performers (competing, exhibition, alumni, guest) that must NOT be
// classified as schedule noise.
const REAL_PERFORMERS = [
  'Apogee',
  'Sacramento Freelancers',
  'U.S. Marine Drum & Bugle Corps',
  'Phantom Regiment Alumni Corps',
  'Sparta Ignite',
  'The ConneXion',
  'The Marching Elite',
  'Legacy Drum & Bugle Corps',
  'Eastern Connecticut Symphony Orchestra',
  'Bluecoats',
  'Carolina Crown',
  'Santa Clara Vanguard',
  'North Star',
  'Phoenix',
];

console.log('--- Pure matcher: schedule noise ---');
for (const name of SCHEDULE_NOISE) {
  assert(isScheduleItem(name), `schedule noise classified: «${name}»`);
}

console.log('\n--- Pure matcher: real performers survive ---');
for (const name of REAL_PERFORMERS) {
  assert(!isScheduleItem(name), `real performer not flagged: «${name}»`);
}

console.log('\n--- Dash/case normalization ---');
assert(isScheduleItem('AGE-OUT CEREMONY' as string), 'dash + case folded: «AGE-OUT CEREMONY»');
assert(SCHEDULE_ITEM_PATTERNS.length > 0, 'schedule_item patterns are non-empty');

// Joint performances and show-segment arcs: not standalone corps.
const NON_CORPS = [
  'Rhythm IN BLUE - Bluecoats',
  'Bluecoats Alumni Legacy Arc',
  'Bluecoats Alumni Ensemble Legacy Arc',
];
const STANDALONE_CORPS = [
  'Rhythm IN BLUE',
  'Bluecoats',
  'EN-CORPS by EN-RICH-MENT',
  'U.S. Marine Drum & Bugle Corps',
  'Phantom Regiment Alumni Corps',
  'Hawthorne Caballeros Alumni',
];

console.log('\n--- Non-corps: joint performances + arcs ---');
for (const name of NON_CORPS) {
  assert(isNonCorpsName(name), `non-corps flagged: «${name}»`);
}
console.log('\n--- Standalone corps survive isNonCorpsName ---');
for (const name of STANDALONE_CORPS) {
  assert(!isNonCorpsName(name), `standalone corps not flagged: «${name}»`);
}
// Joint/arc are non-corps but NOT schedule_item (different category).
assert(!isScheduleItem('Rhythm IN BLUE - Bluecoats'), 'joint perf is not a schedule_item');

console.log('\n--- Alumni/legacy name detection ---');
const ALUMNI = [
  'Buccaneers Alumni',
  'CT Alumni',
  'Mandarins Alumni',
  'Phantom Regiment Alumni Corps',
  'Hawthorne Caballeros Alumni',
  'Troopers Legacy Corps',
];
for (const name of ALUMNI) assert(isAlumniName(name), `alumni detected: «${name}»`);
// Real performers / competitive corps are not alumni by name.
for (const name of ['Bluecoats', 'Apogee', 'Sparta Ignite', 'Carolina Crown']) {
  assert(!isAlumniName(name), `not alumni: «${name}»`);
}
// Alumni are real corps — never treated as non-corps noise.
assert(!isNonCorpsName('Phantom Regiment Alumni Corps'), 'alumni corps is not non-corps noise');

// --- DB drift guard (best-effort; skips cleanly if the view/data isn't present) ---
const runDbChecks = async () => {
  const db = createClient({ url: 'file:./dci-relational.db' });
  const viewExists = await db.execute(
    "SELECT 1 FROM sqlite_master WHERE type='view' AND name='season_performing_corps'"
  );
  if (viewExists.rows.length === 0) {
    console.log('\n[skip] season_performing_corps view not present — run applyLineupClassification --apply first.');
    db.close();
    return;
  }

  console.log('\n--- DB drift guard: season_performing_corps ---');
  // No deleted/bogus schedule corps should remain as a performing corps.
  const noise = await db.execute(`
    SELECT spc.corps_key FROM season_performing_corps spc
    JOIN corps c ON c.corps_key = spc.corps_key
    WHERE lower(c.name) LIKE '%concludes%'
       OR lower(c.name) LIKE '%reserved seating%'
       OR lower(c.name) LIKE '%cinecast%'
       OR lower(c.name) LIKE '%resumes%'
       OR lower(c.name) LIKE '%levels open%'
       OR lower(c.name) LIKE '% - %'
       OR lower(c.name) LIKE '%legacy arc%'
  `);
  assert(noise.rows.length === 0, 'no schedule-noise / joint / arc corps in season_performing_corps');

  db.close();
};

await runDbChecks();

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
