// Effect workflow for an in-season DCI update.
//
// Usage:
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --fine-tune --model-dir models/v9_subcaption_fixed/<run>
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --as-of-date 2026-07-05 --fine-tune --model-dir latest
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --dry-run
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --skip-corps   # skip corps refresh
//   npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 --skip-read-model  # skip final read-model emit

import { Effect, Layer } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runEmit, parseArgs as parseEmitArgs } from './emitReadModel.js';
import { DATASETS, uploadDataset } from '../src/dataSync.js';
import { loadEnv } from './loadEnv.js';
import { makeDbBackedDciApiLayer } from '../src/dbBackedApi.js';
import { makeWebsiteScraperDciApiLayer, makeWebsiteScraperDciApi } from '../src/websiteApi.js';
import { BrowserbaseService, BrowserbaseServiceLive } from '../src/browserbaseService.js';
import { DciApi } from '../src/service.js';

// A DciApi layer whose website scraping runs through Browserbase (to bypass
// bot-protection). Reconstructed locally: the former
// `makeWebsiteScraperWithBrowserbaseLayer` export was removed from runtime.ts,
// which left this workflow unable to even load. Selected via `--source browserbase`.
const makeWebsiteScraperWithBrowserbaseLayer = () =>
  Layer.effect(
    DciApi,
    Effect.gen(function* () {
      const bb = yield* (BrowserbaseService);
      return yield* (makeWebsiteScraperDciApi({ fetchHtml: (url) => bb.fetchHtml(url) }));
    })
  ).pipe(Layer.provide(BrowserbaseServiceLive));
import { ensureRelationalSchema, ingestRelationalData, upsertEvent } from '../src/relational.js';
import type * as Domain from '../src/domain.js';

type Cli = {
  season: string;
  db: string;
  asOfDate: string;
  dryRun: boolean;
  force: boolean;
  allowFutureData: boolean;
  source: 'website' | 'browserbase' | 'legacy-api';
  skipApi: boolean;
  skipCorps: boolean;
  skipEventPages: boolean;
  skipRecaps: boolean;
  skipMl: boolean;
  skipReadModel: boolean;
  fineTune: boolean;
  modelDir?: string;
  epochs: number;
  patience: number;
  samplesPerEpoch: number;
  batch: number;
  lookaheadDays: number;
  refreshPastDays: number;
  outDir: string;
};

type DbSnapshot = {
  events: number;
  competitions: number;
  releasedCompetitions: number;
  scoredCompetitions: number;
  corpsScores: number;
  captionScores: number;
  judgeScores: number;
  websiteRecaps: number;
  lineupEntries: number;
  mlRows: number;
};

type ShowRow = {
  slug: string;
  name: string;
  event_name: string | null;
  start_date: string;
  start_time: string | null;
  web_start_time: string | null;
  edt_start_time: string | null;
  timezone: string | null;
  location_city: string | null;
  location_state: string | null;
  lineup_entries: number;
};

type CompetitionRow = {
  slug: string;
  event_name: string;
  date: string;
  scores_released: number;
  recap_released: number;
  corps_scores: number;
  caption_scores: number;
  judge_scores: number;
  website_recaps: number;
};

const getArg = (argv: string[], flag: string, fallback?: string) => {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return fallback;
  return argv[idx + 1];
};

const hasFlag = (argv: string[], flag: string) => argv.includes(flag);

const parseSource = (value: string | undefined): Cli['source'] => {
  if (value === 'legacy-api' || value === 'browserbase') return value;
  return 'website';
};

const parseCli = (argv: string[]): Cli => ({
  season: getArg(argv, '--season', '2026')!,
  db: getArg(argv, '--db', 'file:./dci-relational.db')!,
  asOfDate: getArg(argv, '--as-of-date', new Date().toISOString().slice(0, 10))!,
  dryRun: hasFlag(argv, '--dry-run'),
  force: hasFlag(argv, '--force'),
  allowFutureData: hasFlag(argv, '--allow-future-data'),
  source: parseSource(getArg(argv, '--source', getArg(argv, '--api-source', 'website'))),
  skipApi: hasFlag(argv, '--skip-api'),
  skipCorps: hasFlag(argv, '--skip-corps'),
  skipEventPages: hasFlag(argv, '--skip-event-pages'),
  skipRecaps: hasFlag(argv, '--skip-recaps'),
  skipMl: hasFlag(argv, '--skip-ml'),
  skipReadModel: hasFlag(argv, '--skip-read-model'),
  fineTune: hasFlag(argv, '--fine-tune'),
  modelDir: getArg(argv, '--model-dir'),
  epochs: Number(getArg(argv, '--epochs', '30')),
  patience: Number(getArg(argv, '--patience', '10')),
  samplesPerEpoch: Number(getArg(argv, '--samples-per-epoch', '2048')),
  batch: Number(getArg(argv, '--batch', '256')),
  lookaheadDays: Number(getArg(argv, '--lookahead-days', '21')),
  refreshPastDays: Number(getArg(argv, '--refresh-past-days', '3')),
  outDir: getArg(argv, '--out-dir', 'results/season-updates')!,
});

const nowStamp = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const quoteCommand = (cmd: string, args: string[]) =>
  [cmd, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');

const runCommand = (cmd: string, args: string[], dryRun: boolean) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        console.log(`\n>>> ${quoteCommand(cmd, args)}`);
        if (dryRun) {
          resolve();
          return;
        }
        // Run child tsx scripts under the SDK's pinned Node 20 via `vp exec`,
        // NOT system `npx` (Node 24 — crashes on the Node-20-built better-sqlite3).
        const useVp = cmd === 'npx' && args[0] === 'tsx';
        const child = spawn(useVp ? 'vp' : cmd, useVp ? ['exec', ...args] : args, {
          cwd: process.cwd(),
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else
            reject(new Error(`Command failed with exit code ${code}: ${quoteCommand(cmd, args)}`));
        });
        child.on('error', reject);
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const querySnapshot = (season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (sql<DbSnapshot>`
      SELECT
        (SELECT COUNT(*) FROM events WHERE season = ${season} OR year = ${season} OR start_date LIKE ${`${season}%`}) AS events,
        (SELECT COUNT(*) FROM competitions WHERE season = ${season}) AS competitions,
        (SELECT COUNT(*) FROM competitions WHERE season = ${season} AND (scores_released = 1 OR recap_released = 1)) AS releasedCompetitions,
        (SELECT COUNT(DISTINCT competition_slug) FROM corps_scores WHERE competition_slug IN (SELECT slug FROM competitions WHERE season = ${season})) AS scoredCompetitions,
        (SELECT COUNT(*) FROM corps_scores WHERE competition_slug IN (SELECT slug FROM competitions WHERE season = ${season})) AS corpsScores,
        (SELECT COUNT(*) FROM caption_scores WHERE competition_slug IN (SELECT slug FROM competitions WHERE season = ${season})) AS captionScores,
        (SELECT COUNT(*) FROM judge_scores WHERE competition_slug IN (SELECT slug FROM competitions WHERE season = ${season})) AS judgeScores,
        (SELECT COUNT(*) FROM website_recaps WHERE season = ${season}) AS websiteRecaps,
        (SELECT COUNT(*) FROM event_lineup_entries WHERE event_slug IN (SELECT slug FROM events WHERE season = ${season} OR year = ${season} OR start_date LIKE ${`${season}%`})) AS lineupEntries,
        (SELECT COUNT(*) FROM ml_sequence_rows_v9_subcaption WHERE season = ${season}) AS mlRows
    `);
    return (
      rows[0] ?? {
        events: 0,
        competitions: 0,
        releasedCompetitions: 0,
        scoredCompetitions: 0,
        corpsScores: 0,
        captionScores: 0,
        judgeScores: 0,
        websiteRecaps: 0,
        lineupEntries: 0,
        mlRows: 0,
      }
    );
  });

const querySchedule = (
  season: string,
  asOfDate: string,
  lookaheadDays: number,
  refreshPastDays: number
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (sql<ShowRow>`
      SELECT
        e.slug,
        e.name,
        e.event_name,
        e.start_date,
        e.start_time,
        e.web_start_time,
        e.edt_start_time,
        e.timezone,
        e.location_city,
        e.location_state,
        COUNT(ele.entry_id) AS lineup_entries
      FROM events e
      LEFT JOIN event_lineup_entries ele ON ele.event_slug = e.slug
      WHERE e.season = ${season}
         OR e.year = ${season}
         OR e.start_date LIKE ${`${season}%`}
      GROUP BY e.slug
      ORDER BY e.start_date ASC, COALESCE(e.start_time, e.web_start_time, e.edt_start_time, '') ASC
    `);

    const anchor = new Date(`${asOfDate}T00:00:00`);
    const from = new Date(anchor.getTime() - refreshPastDays * 24 * 60 * 60 * 1000);
    const to = new Date(anchor.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
    const relevant = rows.filter((row) => {
      const t = Date.parse(row.start_date);
      return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
    });
    return { all: rows, relevant };
  });

const queryCompetitions = (season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (sql<CompetitionRow>`
      SELECT
        c.slug,
        c.event_name,
        c.date,
        c.scores_released,
        c.recap_released,
        COUNT(DISTINCT cs.corps_key) AS corps_scores,
        COUNT(DISTINCT cap.corps_key || ':' || cap.caption_name) AS caption_scores,
        COUNT(DISTINCT js.corps_key || ':' || js.caption_name || ':' || js.judge_id) AS judge_scores,
        COUNT(DISTINCT wr.recap_slug || ':' || wr.scraped_at) AS website_recaps
      FROM competitions c
      LEFT JOIN corps_scores cs ON cs.competition_slug = c.slug
      LEFT JOIN caption_scores cap ON cap.competition_slug = c.slug
      LEFT JOIN judge_scores js ON js.competition_slug = c.slug
      LEFT JOIN website_recaps wr ON wr.recap_slug = c.slug
      WHERE c.season = ${season}
      GROUP BY c.slug
      ORDER BY c.date ASC, c.slug ASC
    `);
  });

const queryFutureReleasedCompetitions = (season: string, asOfDate: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (sql<CompetitionRow>`
      SELECT
        c.slug,
        c.event_name,
        c.date,
        c.scores_released,
        c.recap_released,
        COUNT(DISTINCT cs.corps_key) AS corps_scores,
        COUNT(DISTINCT cap.corps_key || ':' || cap.caption_name) AS caption_scores,
        COUNT(DISTINCT js.corps_key || ':' || js.caption_name || ':' || js.judge_id) AS judge_scores,
        COUNT(DISTINCT wr.recap_slug || ':' || wr.scraped_at) AS website_recaps
      FROM competitions c
      LEFT JOIN corps_scores cs ON cs.competition_slug = c.slug
      LEFT JOIN caption_scores cap ON cap.competition_slug = c.slug
      LEFT JOIN judge_scores js ON js.competition_slug = c.slug
      LEFT JOIN website_recaps wr ON wr.recap_slug = c.slug
      WHERE c.season = ${season}
        AND c.date > ${asOfDate}
        AND (c.scores_released = 1 OR c.recap_released = 1 OR cs.competition_slug IS NOT NULL)
      GROUP BY c.slug
      ORDER BY c.date ASC, c.slug ASC
    `);
  });

const findLatestModelDir = (root = 'models/v9_subcaption_fixed') => {
  if (!fs.existsSync(root)) return undefined;
  const candidates = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'model.json')))
    .map((dir) => ({ dir, mtime: fs.statSync(path.join(dir, 'model.json')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir;
};

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const printScheduleSummary = (all: readonly ShowRow[], relevant: readonly ShowRow[]) => {
  console.log(`\nSchedule rows: ${all.length}`);
  console.log(`Relevant window rows: ${relevant.length}`);
  for (const row of relevant.slice(0, 20)) {
    const time = row.start_time ?? row.web_start_time ?? row.edt_start_time ?? '?';
    const location = [row.location_city, row.location_state].filter(Boolean).join(', ') || '?';
    console.log(
      `  ${row.start_date} ${time} | ${row.slug} | ${row.event_name ?? row.name} | ${location} | lineup=${row.lineup_entries}`
    );
  }
  if (relevant.length > 20) console.log(`  ... and ${relevant.length - 20} more`);
};

const ingestWebsiteSeasonEvents = (season: string) =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const sql = yield* (SqlClient.SqlClient);
    const events = yield* (
      api
        .listEvents({ season })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Website event ingest failed for ${season}: ${String(error)}`).pipe(
              Effect.as([] as readonly Domain.Event[])
            )
          )
        )
    );
    yield* (
      Effect.forEach(events, (event) => upsertEvent(sql, event), { concurrency: 5, discard: true })
    );
    return { events: events.length, competitions: 0, recaps: 0, corpsScores: 0 };
  });

const program = Effect.gen(function* () {
  const cli = parseCli(process.argv.slice(2));
  const reportPath = path.join(cli.outDir, `season-update-${cli.season}-${nowStamp()}.json`);

  console.log(
    `Season update workflow: season=${cli.season}, asOfDate=${cli.asOfDate}, db=${cli.db}, source=${cli.source}`
  );
  if (cli.dryRun) console.log('Dry-run mode: commands will be printed but not executed.');

  if (!cli.dryRun) {
    yield* (ensureRelationalSchema);
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/ingestLineupsFromScrapes.ts', '--season', cli.season],
        false
      )
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventVenues.ts'], false));
    yield* (
      runCommand('npx', ['tsx', 'scripts/backfillEventSchedulesPerformanceOrder.ts'], false)
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventGroupTypes.ts'], false));
  } else {
    console.log('Dry-run: skipping schema initialization and derived-lineup rehydration.');
  }
  const before = yield* (querySnapshot(cli.season));
  console.log('\nBefore snapshot:', before);

  const futureReleasedBefore = yield* (queryFutureReleasedCompetitions(cli.season, cli.asOfDate));
  if (futureReleasedBefore.length > 0 && !cli.allowFutureData) {
    console.warn(
      `Found ${futureReleasedBefore.length} released/scored competitions after as-of date ${cli.asOfDate}. ` +
        'The V9 builder will exclude them via --as-of-date, but this workflow will not fine-tune unless --allow-future-data is set.'
    );
  }

  if (!cli.skipApi) {
    console.log(
      cli.source === 'legacy-api'
        ? '\nLegacy API ingest: competitions/events/corps/totals/rankings'
        : cli.source === 'browserbase'
          ? '\nBrowserbase website/cache ingest: events, score-list competitions, available recaps'
          : '\nWebsite/cache ingest: events, score-list competitions, available recaps'
    );
    if (!cli.dryRun) {
      if (cli.source === 'website' || cli.source === 'browserbase') {
        const ingest = yield* (ingestWebsiteSeasonEvents(cli.season));
        console.log(`Website event ingest complete: events=${ingest.events}`);
        if (ingest.events === 0) {
          console.warn(
            'Website event ingest returned 0 fresh events. If this is not expected, DCI may be blocking direct fetches; ' +
              'try --source browserbase with BROWSERBASE_API_KEY or rely on existing cached event rows.'
          );
        }
      } else {
        const ingest = yield* (
          ingestRelationalData({
            seasons: [cli.season],
            warm: true,
            seasonConcurrency: 1,
            competitionConcurrency: 2,
            scoreConcurrency: 4,
            persistRankings: true,
          })
        );
        console.log(
          `Legacy API ingest complete: competitions=${ingest.competitions}, recaps=${ingest.recaps}, corpsScores=${ingest.corpsScores}`
        );
      }
    } else {
      console.log(`Would ingest ${cli.source} season ${cli.season}.`);
    }
  }

  // Refresh corps from dci.org (classes + profile fields). Uses the scrape cache
  // (TTL), so only stale pages re-fetch; ingest is coalescing + guardrailed and
  // applies when not a dry-run. Independent of the score/event pipeline.
  if (!cli.skipCorps) {
    console.log(
      '\nCorps scrape: directory classes + profiles (about, socials, logo/cover, address).'
    );
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/scrapeCorps.ts', ...(cli.dryRun ? [] : ['--apply'])],
        cli.dryRun
      )
    );
    // Re-derive the dark-logo flag from the (possibly refreshed) logos so new or
    // changed corps get a dark-mode variant without a manual pass.
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/flagDarkLogos.ts', ...(cli.dryRun ? [] : ['--apply'])],
        cli.dryRun
      )
    );
  }

  const scheduleAfterApi = yield* (
    querySchedule(cli.season, cli.asOfDate, cli.lookaheadDays, cli.refreshPastDays)
  );
  printScheduleSummary(scheduleAfterApi.all, scheduleAfterApi.relevant);

  if (!cli.skipEventPages && (cli.force || scheduleAfterApi.all.length > 0)) {
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/scrapeEventPages.ts', `--season=${cli.season}`],
        cli.dryRun
      )
    );
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/ingestLineupsFromScrapes.ts', '--season', cli.season],
        cli.dryRun
      )
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventVenues.ts'], cli.dryRun));
    yield* (
      runCommand('npx', ['tsx', 'scripts/backfillEventSchedulesPerformanceOrder.ts'], cli.dryRun)
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventGroupTypes.ts'], cli.dryRun));
  }

  const competitions = yield* (queryCompetitions(cli.season));
  const released = competitions.filter((row) => row.scores_released || row.recap_released);
  const needsWebsiteRecap = released.filter(
    (row) => row.website_recaps === 0 || row.judge_scores === 0 || row.caption_scores === 0
  );
  console.log(
    `\nCompetitions: ${competitions.length}; released=${released.length}; needing recap detail=${needsWebsiteRecap.length}`
  );

  if (!cli.skipRecaps && (cli.force || needsWebsiteRecap.length > 0)) {
    yield* (
      runCommand(
        'npx',
        ['tsx', 'src/scrapeWebsiteRecaps.ts', '--db', cli.db, '--season', cli.season],
        cli.dryRun
      )
    );
  } else if (!cli.skipRecaps) {
    console.log('Skipping website recap scrape: no released competitions need recap detail.');
  }

  if (!cli.skipMl && (cli.force || released.length > 0)) {
    yield* (runCommand('npx', ['tsx', 'scripts/recreateViews.ts'], cli.dryRun));
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/ingestLineupsFromScrapes.ts', '--season', cli.season],
        cli.dryRun
      )
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventVenues.ts'], cli.dryRun));
    yield* (
      runCommand('npx', ['tsx', 'scripts/backfillEventSchedulesPerformanceOrder.ts'], cli.dryRun)
    );
    yield* (runCommand('npx', ['tsx', 'scripts/backfillEventGroupTypes.ts'], cli.dryRun));
    // Reconcile events ↔ competitions, then self-heal score visibility:
    // (1) map website events to their API competition slug (exact-slug first, so
    //     two-night siblings don't cross-link); (2) create events for any scored
    //     competition that no event/mapping covers — the finished-season gap that
    //     left e.g. 2025 March On score-less. Mapping MUST precede the backfill so
    //     it only fills genuine gaps (not competitions a website event maps to).
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/backfillEventCompetitionMapping.ts', ...(cli.dryRun ? [] : ['--apply'])],
        cli.dryRun
      )
    );
    yield* (
      runCommand(
        'npx',
        [
          'tsx',
          'scripts/backfillEventsFromCompetitions.ts',
          '--season',
          cli.season,
          ...(cli.dryRun ? [] : ['--apply']),
        ],
        cli.dryRun
      )
    );
    yield* (runCommand('npx', ['tsx', 'scripts/buildCorpsIndexMap.ts'], cli.dryRun));
    yield* (runCommand('npx', ['tsx', 'scripts/buildJudgeIndexMap.ts'], cli.dryRun));
    yield* (runCommand('npx', ['tsx', 'scripts/generateShowMap.ts'], cli.dryRun));
    yield* (runCommand('npx', ['tsx', 'scripts/computeReferenceCurvesV4.ts'], cli.dryRun));
    yield* (
      runCommand(
        'npx',
        ['tsx', 'scripts/buildMlSequencesV9All.ts', '--as-of-date', cli.asOfDate, '--rebuild'],
        cli.dryRun
      )
    );
    yield* (runCommand('npx', ['tsx', 'scripts/auditV9SubcaptionData.ts'], cli.dryRun));
  } else if (!cli.skipMl) {
    console.log(
      'Skipping ML rebuild: no released competitions yet. Use --force to rebuild anyway.'
    );
  }

  let fineTuneModelDir: string | undefined;
  let fineTuneCandidateDir: string | undefined;
  if (cli.fineTune) {
    if (futureReleasedBefore.length > 0 && !cli.allowFutureData) {
      throw new Error(
        `Refusing fine-tune: DB has released/scored ${cli.season} competitions after --as-of-date ${cli.asOfDate}. ` +
          'The ML rebuild is cutoff-safe, but use --allow-future-data only if this is an intentional latest-data run.'
      );
    }
    fineTuneModelDir =
      cli.modelDir === 'latest' || !cli.modelDir ? findLatestModelDir() : cli.modelDir;
    if (!fineTuneModelDir) {
      throw new Error(
        '--fine-tune requested but no --model-dir was provided and no latest model was found.'
      );
    }
    yield* (
      runCommand(
        'npx',
        [
          'tsx',
          'src/training/trainModelV9Subcaption-fixed.ts',
          '--load-model',
          fineTuneModelDir,
          '--trial-id',
          `${cli.season}_update_${nowStamp()}`,
          '--epochs',
          String(cli.epochs),
          '--patience',
          String(cli.patience),
          '--samples-per-epoch',
          String(cli.samplesPerEpoch),
          '--batch',
          String(cli.batch),
          '--val-mode',
          'date-forward',
          '--division-filter',
          'all',
        ],
        cli.dryRun
      )
    );
    fineTuneCandidateDir = cli.dryRun ? undefined : findLatestModelDir();
  }

  const after = yield* (querySnapshot(cli.season));
  const finalSchedule = yield* (
    querySchedule(cli.season, cli.asOfDate, cli.lookaheadDays, cli.refreshPastDays)
  );
  const finalCompetitions = yield* (queryCompetitions(cli.season));

  const report = {
    generated_at: new Date().toISOString(),
    season: cli.season,
    db: cli.db,
    as_of_date: cli.asOfDate,
    dry_run: cli.dryRun,
    future_released_after_as_of: futureReleasedBefore,
    before,
    after,
    schedule: {
      total_events: finalSchedule.all.length,
      relevant_events: finalSchedule.relevant,
      events_missing_lineup: finalSchedule.all.filter((row) => row.lineup_entries === 0),
    },
    competitions: {
      total: finalCompetitions.length,
      released: finalCompetitions.filter((row) => row.scores_released || row.recap_released),
      needing_recap_detail: finalCompetitions.filter(
        (row) =>
          (row.scores_released || row.recap_released) &&
          (row.website_recaps === 0 || row.judge_scores === 0 || row.caption_scores === 0)
      ),
    },
    fine_tune: cli.fineTune
      ? {
          source_model_dir: fineTuneModelDir,
          candidate_model_dir: fineTuneCandidateDir,
          status: cli.dryRun ? 'dry_run' : 'candidate_not_auto_promoted',
          epochs: cli.epochs,
          samples_per_epoch: cli.samplesPerEpoch,
          batch: cli.batch,
        }
      : null,
    notes: [
      cli.source === 'legacy-api'
        ? 'Legacy API ingest was used. This is no longer the default because the public DCI API has been deprecated/removed.'
        : cli.source === 'browserbase'
          ? "Browserbase-backed website/cache ingest was used. This is preferred when DCI's website blocks direct server-side fetches."
          : "Website/cache ingest was used. DCI's legacy public API is deprecated/removed, so future seasons should be refreshed from website pages and cached responses.",
      'Corps scrape refreshes classes + profile fields (about/socials/logo/cover/address) from dci.org via Browserbase+cache; coalescing + guardrailed (curated locations preserved). Skip with --skip-corps.',
      'Website recap scrape fills judge/caption/subcaption details when released.',
      'Event page scrape fills lineup/performance order for upcoming prediction context.',
      'Fine-tuning uses the current V9 subcaption trainer with --load-model and date-forward validation.',
      'Generated V9 ML rows use --as-of-date so future competition rows and future Elo updates are excluded.',
      'Fine-tuned models are candidates. Promote manually after reviewing model-card.json and named eval slices.',
    ],
  };

  writeJson(reportPath, report);
  console.log(`\nWrote season update report: ${reportPath}`);
  console.log('After snapshot:', after);
});

const cli = parseCli(process.argv.slice(2));
const SqlLayer = LibsqlClient.layer({ url: cli.db });
const ApiLayer =
  cli.source === 'legacy-api'
    ? makeDbBackedDciApiLayer()
    : cli.source === 'browserbase'
      ? makeWebsiteScraperWithBrowserbaseLayer()
      : makeWebsiteScraperDciApiLayer();
const CombinedLayer = Layer.merge(SqlLayer, ApiLayer).pipe(Layer.provide(SqlLayer));

// Final step (READ_MODEL_PLAN §7): once the workflow's writes are committed and
// its DB layer is released, re-emit the read-model so the app serves fresh data.
// Runs in a fresh pass (reads the just-updated DB); skip with --skip-read-model
// or --dry-run. The in-app 2026 refresh inherits this automatically (it invokes
// this workflow without --skip-read-model).
const dbPath = cli.db.replace(/^file:/, '');
const emitReadModelStep = async () => {
  if (cli.dryRun || cli.skipReadModel) {
    console.log(
      cli.dryRun ? '\n[read-model] dry-run — skipping emit.' : '\n[read-model] --skip-read-model set — skipping emit.'
    );
    return;
  }
  console.log('\n[read-model] emitting read-model (final ingest step)…');
  // Also emit the JSON snapshot (offline payload, READ_MODEL_PLAN §9) to the
  // repo's served public/ dir. cwd is the sdk dir, so public/ is one level up.
  const jsonSnapshot = path.resolve(process.cwd(), '..', 'public', 'read-model');
  await runEmit(parseEmitArgs(['--source', dbPath, '--json-snapshot', jsonSnapshot]));

  // Distribute the freshly-emitted read-model to R2 so the app can pull it
  // (replaces the old Turso sync). Best-effort: a missing-creds environment must
  // not fail ingest — the local A/B slots were already updated by the emit above.
  try {
    loadEnv();
    console.log('[read-model] pushing to R2…');
    await uploadDataset(DATASETS['read-model'], (m) => console.log(`  ${m}`));
  } catch (err) {
    console.warn('[read-model] R2 push skipped:', (err as Error)?.message ?? err);
  }
};

// After ingest, before emit: re-heal manual staff curation that a fresh scrape may
// have re-split or re-created (idempotent). Keeps merges/consolidations durable.
// Best-effort — a failure here must not abort the workflow or block the emit.
const reapplyCurationStep = async () => {
  if (cli.dryRun) {
    console.log('\n[curation] dry-run — skipping reapply.');
    return;
  }
  console.log('\n[curation] re-applying staff curation (durability pass)…');
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['tsx', 'scripts/reapplyStaffCuration.ts', '--apply'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn('[curation] reapply skipped:', (err as Error)?.message ?? err);
  }
};

Effect.runPromise(program.pipe(Effect.provide(CombinedLayer)))
  .then(reapplyCurationStep)
  .then(emitReadModelStep)
  .catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
