// Ingest everything: API, website recaps, and Wayback data.
// Usage: npx tsx scripts/ingestAllData.ts [--seasons 2013,2014,...] [--no-cache-first] [--cache-only] [--no-wayback-prime] [--skip-wayback] [--wayback-all] [--wayback-events <file>] [--wayback-corps <file>] [--fetch-current-year]

import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (command: string) => {
  console.log(`\n>>> ${command}`);
  execSync(command, { stdio: 'inherit' });
};

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const hasFlag = (flag: string) => process.argv.includes(flag);

const seasons = getArg('--seasons');
const seasonArgs = seasons ? ` --seasons ${seasons}` : '';

const skipWayback = hasFlag('--skip-wayback');
const waybackAll = hasFlag('--wayback-all');
const waybackEvents = getArg('--wayback-events');
const waybackCorps = getArg('--wayback-corps');
const fetchCurrentYear = hasFlag('--fetch-current-year');
const cacheFirst = !hasFlag('--no-cache-first');
const cacheOnly = hasFlag('--cache-only');
const waybackPrime = !hasFlag('--no-wayback-prime');

const defaultWaybackEvents = path.join('wayback', 'wayback_dci_all_events_complete.json');
const defaultWaybackCorps = path.join('wayback', 'wayback_dci_corps_contacts_complete.json');

const main = () => {
  console.log('====================================================');
  console.log('   FULL INGEST: API + WEBSITE + WAYBACK   ');
  console.log('====================================================');
  console.log(
    `[ingest-all] mode cacheFirst=${cacheFirst} cacheOnly=${cacheOnly} waybackPrime=${waybackPrime} skipWayback=${skipWayback}`
  );
  if (seasons) {
    console.log(`[ingest-all] seasons=${seasons}`);
  }

  if (cacheFirst || cacheOnly) {
    console.log('[ingest-all] Stage 1/4: cache-first ingest (API cache + website recap cache)');
    run(`npx tsx scripts/ingestApiFromCache.ts${seasonArgs}`);
    run(`npx tsx src/reingestFromCache.ts --db file:./dci-relational.db${seasonArgs} --skip-api`);
  } else {
    console.log('[ingest-all] Stage 1/4: cache-first ingest disabled (--no-cache-first)');
  }

  if (!cacheOnly) {
    if (waybackPrime) {
      console.log('[ingest-all] Stage 2/5: prime Wayback event availability cache');
      run(
        `npx tsx scripts/primeWaybackEventAvailability.ts --db file:./dci-relational.db${seasonArgs}`
      );
      run(
        `npx tsx scripts/primeWaybackApiAvailability.ts --db file:./dci-relational.db${seasonArgs}`
      );
    } else {
      console.log('[ingest-all] Stage 2/5: skipped Wayback prime (--no-wayback-prime)');
    }

    console.log('[ingest-all] Stage 3/5: live API + live website scrape');
    run('npx tsx scripts/ingestAllSeasons.ts');
    run(`npx tsx src/scrapeWebsiteRecaps.ts --db file:./dci-relational.db${seasonArgs}`);
  } else {
    console.log('[ingest-all] Stage 2/5: skipped Wayback prime (--cache-only)');
    console.log('[ingest-all] Stage 3/5: skipped live API/website fetch (--cache-only)');
  }

  if (!skipWayback) {
    console.log('[ingest-all] Stage 4/5: Wayback ingest');
    const waybackEventPath = waybackEvents ?? defaultWaybackEvents;
    const waybackCorpsPath = waybackCorps ?? defaultWaybackCorps;

    if (waybackAll) {
      run('npx tsx scripts/ingestWaybackEvents.ts --all');
    } else if (fs.existsSync(waybackEventPath)) {
      const fetchFlag = fetchCurrentYear ? ' --fetch-current-year' : '';
      run(`npx tsx scripts/ingestWaybackEvents.ts ${waybackEventPath}${fetchFlag}`);
    } else {
      console.warn(`Wayback events file not found: ${waybackEventPath}`);
    }

    if (fs.existsSync(waybackCorpsPath)) {
      run(`npx tsx scripts/ingestWaybackCorpsContacts.ts ${waybackCorpsPath}`);
    } else {
      console.warn(`Wayback corps contacts file not found: ${waybackCorpsPath}`);
    }
  } else {
    console.log('[ingest-all] Stage 4/5: skipped Wayback ingest (--skip-wayback)');
  }

  // Wayback ingest calls ensureRelationalSchema, which can reset lineup/group-type
  // derivative tables. Rebuild them at the end so ingestAllData always leaves a
  // fully-populated event lineup + ordering dataset.
  console.log('[ingest-all] Stage 5/5: post-ingest rebuild + retry failures');
  run('npx tsx scripts/backfillEventVenues.ts');
  run('npx tsx scripts/ingestLineupsFromScrapes.ts');
  run('npx tsx scripts/backfillEventSchedulesPerformanceOrder.ts');
  run('npx tsx scripts/backfillEventGroupTypes.ts');
  run(`npx tsx scripts/retryWebsiteScrapeFailures.ts --db file:./dci-relational.db${seasonArgs}`);

  console.log('[ingest-all] Completed.');
};

main();
