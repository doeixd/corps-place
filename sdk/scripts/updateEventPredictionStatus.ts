import { createClient, type Client } from '@libsql/client';
import { spawn } from 'node:child_process';
import {
  ensureEventPredictionTables,
  latestEventPredictionRun,
  summarizeEventPredictionErrors,
  updateEventPredictionErrors,
  type ModelEventPredictionActualRow,
  type ModelEventPredictionRun,
} from '../src/training/v9EventPredictionDb.js';
import { findLatestV9SubcaptionModelDir } from '../src/training/v9ModelPaths.js';

type Cli = {
  event: string;
  season: string;
  db: string;
  predictionId?: string;
  modelDir?: string;
  refresh: boolean;
  fineTune: boolean;
  updatePrediction: boolean;
  allowFutureData: boolean;
  checkOnly: boolean;
};

const usage = () => `
Usage:
  npx tsx scripts/updateEventPredictionStatus.ts --event <slug-or-name> [options]

Options:
  --season 2026                  Season. Default: 2026
  --db file:./dci-relational.db  LibSQL/SQLite URL. Default: file:./dci-relational.db
  --prediction-id <id>           Specific saved prediction run. Default: latest for event
  --model-dir <dir>|latest       Model to fine-tune/update prediction from. Default: saved prediction model/latest
  --refresh                      Run season update workflow first to ingest released scores/recaps.
  --fine-tune                    Fine-tune using seasonUpdateWorkflow after scores are present.
  --update-prediction            Regenerate and save a fresh prediction after refresh/fine-tune.
  --allow-future-data            Forwarded to seasonUpdateWorkflow fine-tune.
  --check-only                   Only report score/prediction status.
`;

const getArg = (argv: string[], flag: string, fallback?: string) => {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
};

const hasFlag = (argv: string[], flag: string) => argv.includes(flag);

const parseCli = (argv: string[]): Cli => {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(usage().trim());
    process.exit(0);
  }
  const event = getArg(argv, '--event') ?? getArg(argv, '--slug') ?? getArg(argv, '--event-slug');
  if (!event) {
    console.log(usage().trim());
    process.exit(1);
  }
  return {
    event,
    season: getArg(argv, '--season', '2026')!,
    db: getArg(argv, '--db', 'file:./dci-relational.db')!,
    predictionId: getArg(argv, '--prediction-id'),
    modelDir: getArg(argv, '--model-dir'),
    refresh: hasFlag(argv, '--refresh'),
    fineTune: hasFlag(argv, '--fine-tune'),
    updatePrediction: hasFlag(argv, '--update-prediction'),
    allowFutureData: hasFlag(argv, '--allow-future-data'),
    checkOnly: hasFlag(argv, '--check-only'),
  };
};

const quoteCommand = (cmd: string, args: string[]) =>
  [cmd, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');

const runCommand = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    console.log(`\n>>> ${quoteCommand(cmd, args)}`);
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Command failed with exit code ${code}: ${quoteCommand(cmd, args)}`))
    );
    child.on('error', reject);
  });

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function resolveEventSlug(db: Client, season: string, eventText: string) {
  const exact = await db.execute({
    sql: 'SELECT slug FROM events WHERE (season = ? OR year = ? OR start_date LIKE ?) AND (slug = ? OR slug = ?) LIMIT 2',
    args: [season, season, `${season}%`, eventText, slugify(eventText)],
  });
  if (exact.rows.length === 1) return String((exact.rows[0] as any).slug);

  const rows = await db.execute({
    sql: 'SELECT slug, name, event_name FROM events WHERE season = ? OR year = ? OR start_date LIKE ?',
    args: [season, season, `${season}%`],
  });
  const needle = normalize(eventText);
  const matches = rows.rows.filter(
    (row: any) =>
      normalize(String(row.slug)).includes(needle) ||
      normalize(String(row.name ?? '')).includes(needle) ||
      normalize(String(row.event_name ?? '')).includes(needle)
  );
  if (matches.length === 1) return String((matches[0] as any).slug);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous event '${eventText}': ${matches.map((row: any) => row.slug).join(', ')}`
    );

  const compExact = await db.execute({
    sql: 'SELECT slug FROM competitions WHERE season = ? AND (slug = ? OR slug = ?) LIMIT 2',
    args: [season, eventText, slugify(eventText)],
  });
  if (compExact.rows.length === 1) return String((compExact.rows[0] as any).slug);

  const comps = await db.execute({
    sql: 'SELECT slug, event_name FROM competitions WHERE season = ?',
    args: [season],
  });
  const compMatches = comps.rows.filter(
    (row: any) =>
      normalize(String(row.slug)).includes(needle) ||
      normalize(String(row.event_name ?? '')).includes(needle)
  );
  if (compMatches.length === 1) return String((compMatches[0] as any).slug);
  if (compMatches.length > 1)
    throw new Error(
      `Ambiguous competition '${eventText}': ${compMatches.map((row: any) => row.slug).join(', ')}`
    );
  throw new Error(
    `Event or competition '${eventText}' not found for ${season}. Run with --refresh to ingest/scrape the schedule and scores.`
  );
}

async function findCompetitionSlug(
  db: Client,
  season: string,
  eventSlug: string,
  run?: ModelEventPredictionRun
) {
  if (run?.competition_slug) return run.competition_slug;
  const result = await db.execute({
    sql: 'SELECT slug FROM competitions WHERE season = ? AND (slug = ? OR slug = ?) ORDER BY date DESC LIMIT 1',
    args: [season, eventSlug, `${season}-${eventSlug}`],
  });
  return (result.rows[0] as any)?.slug as string | undefined;
}

async function actualRows(
  db: Client,
  competitionSlug: string
): Promise<ModelEventPredictionActualRow[]> {
  const result = await db.execute({
    sql: `
      SELECT
        cs.corps_key,
        cs.corps_name,
        cs.division_name,
        cs.rank,
        cs.total_score,
        MAX(CASE WHEN caps.caption_initials = 'GE1' THEN caps.score END) AS GE1,
        MAX(CASE WHEN caps.caption_initials = 'GE2' THEN caps.score END) AS GE2,
        MAX(CASE WHEN caps.caption_initials = 'VP' THEN caps.score END) AS VP,
        MAX(CASE WHEN caps.caption_initials = 'VA' THEN caps.score END) AS VA,
        MAX(CASE WHEN caps.caption_initials = 'CG' THEN caps.score END) AS CG,
        MAX(CASE WHEN caps.caption_initials = 'MB' THEN caps.score END) AS MB,
        MAX(CASE WHEN caps.caption_initials = 'MA' THEN caps.score END) AS MA,
        MAX(CASE WHEN caps.caption_initials = 'MP' THEN caps.score END) AS MP
      FROM corps_scores cs
      LEFT JOIN caption_scores caps
        ON caps.competition_slug = cs.competition_slug
       AND caps.corps_key = cs.corps_key
      WHERE cs.competition_slug = ?
        AND cs.total_score > 0
      GROUP BY cs.competition_slug, cs.corps_key
      ORDER BY cs.rank ASC
    `,
    args: [competitionSlug],
  });
  return result.rows as unknown as ModelEventPredictionActualRow[];
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.refresh) {
    const args = [
      'tsx',
      'scripts/seasonUpdateWorkflow.ts',
      '--season',
      cli.season,
      '--as-of-date',
      new Date().toISOString().slice(0, 10),
    ];
    if (!cli.fineTune) args.push('--skip-ml');
    if (cli.allowFutureData) args.push('--allow-future-data');
    await runCommand('npx', args);
  }

  const db = createClient({ url: cli.db });
  try {
    await ensureEventPredictionTables(db);
    const eventSlug = await resolveEventSlug(db, cli.season, cli.event);
    const run = await latestEventPredictionRun(db, eventSlug, cli.predictionId);
    const competitionSlug = await findCompetitionSlug(db, cli.season, eventSlug, run);
    const actuals = competitionSlug ? await actualRows(db, competitionSlug) : [];

    console.log(`Event: ${eventSlug}`);
    console.log(`Competition: ${competitionSlug ?? 'not found'}`);
    console.log(`Saved prediction: ${run?.prediction_id ?? 'not found'}`);
    console.log(`Actual score rows: ${actuals.length}`);

    if (run && actuals.length > 0) {
      const update = await updateEventPredictionErrors(db, run, actuals, normalize);
      const summary = await summarizeEventPredictionErrors(db, run.prediction_id);
      console.log('Prediction comparison:', update);
      console.table([summary]);
    } else if (!run) {
      console.log(
        'No saved prediction run found. Create one with: npm run event:predict -- --event ... --save-db'
      );
    } else {
      console.log(
        'Scores are not available yet. Run with --refresh after the event/recap is released.'
      );
    }

    if (cli.checkOnly) return;

    if (cli.fineTune) {
      if (actuals.length === 0)
        throw new Error('Refusing fine-tune: no actual score rows are available yet.');
      const modelDir = cli.modelDir ?? run?.model_dir ?? 'latest';
      const args = [
        'tsx',
        'scripts/seasonUpdateWorkflow.ts',
        '--season',
        cli.season,
        '--as-of-date',
        new Date().toISOString().slice(0, 10),
        '--fine-tune',
        '--model-dir',
        modelDir,
      ];
      if (cli.allowFutureData) args.push('--allow-future-data');
      await runCommand('npx', args);
    }

    if (cli.updatePrediction) {
      const args = [
        'tsx',
        'scripts/predictEventRecap.ts',
        '--event',
        eventSlug,
        '--season',
        cli.season,
        '--save-db',
      ];
      const modelDir = cli.fineTune
        ? (findLatestV9SubcaptionModelDir() ?? cli.modelDir ?? 'latest')
        : (cli.modelDir ?? 'latest');
      args.push('--model-dir', modelDir);
      await runCommand('npx', args);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
