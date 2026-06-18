import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import { makeWebsiteScraperWithBrowserbaseLayer } from '../src/runtime.js';
import { DciApi } from '../src/service.js';

/**
 * Test script to verify Browserbase integration.
 *
 * To run with Browserbase:
 *   BROWSERBASE_API_KEY=your_key npx tsx scripts/testBrowserbase.ts
 *
 * To run without Browserbase (should fall back to direct fetch):
 *   npx tsx scripts/testBrowserbase.ts
 */

const testRecap = Effect.gen(function* () {
  const api = yield* (DciApi);
  const slug = '2025-dci-eastern-classic';

  console.log(`[test] Fetching recap for ${slug}...`);
  const result = yield* (api.getCompetitionRecap(slug));
  console.log(`[test] Got ${result.length} scores`);

  if (result.length > 0) {
    console.log(`[test] First score: ${result[0].groupName} = ${result[0].totalScore}`);
  }

  console.log('[test] Done');
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

// Use the Browserbase-aware scraper layer
const ApiLayer = makeWebsiteScraperWithBrowserbaseLayer();

const program = testRecap.pipe(
  Effect.provide(ApiLayer),
  Effect.provide(SqlLayer),
  Effect.catch((err) => {
    console.error('[test] Error:', err);
    return Effect.void;
  })
);

Effect.runPromise(program).catch((err) => {
  console.error('[test] Fatal:', err);
  process.exit(1);
});
