import { createClient, type Client } from '@libsql/client';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V9_CAPTIONS, type V9Caption as Caption } from '../src/training/v9Baselines.js';
import {
  aggregateV9BreakdownSubcaptions,
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
  type V9BreakdownSubcaptionRow,
} from '../src/training/v9BreakdownData.js';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';
import {
  saveEventPredictionRun,
  eventPredictionInputSignature,
} from '../src/training/v9EventPredictionDb.js';
import { findLatestV9SubcaptionModelDir } from '../src/training/v9ModelPaths.js';
import { V9_RAW_STATIC_DIM, type PredictionContextMode } from '../src/training/v9FeatureModes.js';
import {
  splitV9RecapWithCurvesAndPrior,
  validateV9BreakdownSplitCurveArtifact,
  type V9BreakdownPriorShare,
  type V9BreakdownSplitCurveArtifact,
} from '../src/training/v9BreakdownSplitCurves.js';

type Cli = {
  event: string;
  season: string;
  db: string;
  modelDir?: string;
  division: string;
  mode: PredictionContextMode | 'auto';
  percentThrough?: number;
  refresh: boolean;
  forceRefresh: boolean;
  checkOnly: boolean;
  saveDb: boolean;
  output?: string;
  breakdownSplitCurves?: string;
  sameSeasonBreakdownPrior: boolean;
};

type EventRow = {
  event_id: string;
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
  event_image?: string | null;
  event_image_thumb?: string | null;
  ticket_watermark?: string | null;
  ticketing_map_image?: string | null;
  street_map_image?: string | null;
  buy_tickets?: string | null;
  buy_tickets_text?: string | null;
  live_stream_link?: string | null;
  description?: string | null;
  meta_description?: string | null;
  notes_general?: string | null;
  notes_lineup_times?: string | null;
  venue_city?: string | null;
  venue_state?: string | null;
  min_ticket_price?: string | null;
  max_ticket_price?: string | null;
};

type LineupRow = {
  unit_name: string;
  display_city: string | null;
  time: string | null;
  performance_order: number | null;
  corps_key: string | null;
  participant_name: string | null;
  division_name: string | null;
};

type LineupSource =
  | 'event_lineup'
  | 'prior_season_world_finals'
  | 'prior_season_world_semifinals'
  | 'prior_season_world_prelims'
  | 'prior_season_open_finals'
  | 'prior_season_open_semifinals'
  | 'prior_season_open_prelims';

type CompetitionRow = {
  slug: string;
  event_name: string;
  date: string;
  percent_through: number | null;
  scores_released: number;
  recap_released: number;
};

type PriorSeasonComparable = {
  total: number;
  percentThrough: number;
  date: string;
  competitionSlug: string;
  captions?: Record<Caption, number>;
};

const captionToJudgeIndexSlot: Record<string, number> = {
  GE1: 0,
  GE2: 1,
  VP: 2,
  VA: 3,
  CG: 4,
  MB: 5,
  MA: 6,
  MP: 7,
};
const CAPTIONS = [...V9_CAPTIONS];

const isAllAgeDivision = (division: string | null | undefined) =>
  /\ball[-\s]?age\b/i.test(division ?? '');

const isSupportedPredictionDivision = (division: string | null | undefined) =>
  division === 'World Class' || division === 'Open Class' || isAllAgeDivision(division);

const predictionDivision = (cli: Cli, entry: LineupRow) =>
  cli.division.toLowerCase() === 'auto' ? entry.division_name || 'World Class' : cli.division;

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b(the|drum|bugle|corps|inc|incorporated|connecticut)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();

const usage = () => `
Usage:
  npx tsx scripts/predictEventRecap.ts --event <slug-or-name> [options]

Options:
  --season 2026                  Season to search/update. Default: 2026
  --db file:./dci-relational.db  LibSQL/SQLite URL. Default: file:./dci-relational.db
  --model-dir <dir>|latest       V9 model directory. Default: latest
  --division auto                Division for unknown/synthetic corps. Default: auto, using lineup/corps divisions.
  --mode auto|as_of_show_date|preseason_forecast|panel_unknown|lineup_unknown
                                  Default: auto
  --percent-through <n>          Override season progress bucket input.
  --refresh                      Run season update scrape/schedule steps before checking/predicting.
  --force-refresh                Force event page refresh in the update workflow.
  --check-only                   Only print readiness; do not load model or predict.
  --save-db                      Store prediction run and rows in SQLite.
  --output <path>                Output JSON path. Default: results/predictions/<event>-prediction-<timestamp>.json
  --breakdown-split-curves <path>
                                  Content/Achievement split curve JSON. Default: results/v9-breakdown-split-curves.json when present.
  --same-season-breakdown-prior   Blend split curves with earlier same-season corps/caption breakdowns.
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
  const mode = (getArg(argv, '--mode', 'auto') ?? 'auto') as Cli['mode'];
  const allowedModes = new Set([
    'auto',
    'as_of_show_date',
    'preseason_forecast',
    'panel_unknown',
    'lineup_unknown',
  ]);
  if (!allowedModes.has(mode)) throw new Error(`Invalid --mode ${mode}`);

  const percentText = getArg(argv, '--percent-through');
  return {
    event,
    season: getArg(argv, '--season', '2026')!,
    db: getArg(argv, '--db', 'file:./dci-relational.db')!,
    modelDir: getArg(argv, '--model-dir', 'latest'),
    division: getArg(argv, '--division', 'auto')!,
    mode,
    percentThrough: percentText == null ? undefined : Number(percentText),
    refresh: hasFlag(argv, '--refresh') || hasFlag(argv, '--force-refresh'),
    forceRefresh: hasFlag(argv, '--force-refresh'),
    checkOnly: hasFlag(argv, '--check-only'),
    saveDb: hasFlag(argv, '--save-db'),
    output: getArg(argv, '--output'),
    breakdownSplitCurves: getArg(argv, '--breakdown-split-curves', 'results/v9-breakdown-split-curves.json'),
    sameSeasonBreakdownPrior: hasFlag(argv, '--same-season-breakdown-prior'),
  };
};

const loadBreakdownSplitCurves = (artifactPath: string | undefined) => {
  if (!artifactPath) return undefined;
  const resolved = path.resolve(process.cwd(), artifactPath);
  if (!fs.existsSync(resolved)) return undefined;
  const artifact = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  return validateV9BreakdownSplitCurveArtifact(artifact);
};

const quoteCommand = (cmd: string, args: string[]) =>
  [cmd, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');

const runCommand = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    console.log(`\n>>> ${quoteCommand(cmd, args)}`);
    // Run child tsx scripts under the SDK's pinned Node 20 via `vp exec`,
    // NOT system `npx` (Node 24 — crashes on the Node-20-built better-sqlite3).
    const useVp = cmd === 'npx' && args[0] === 'tsx';
    const child = spawn(useVp ? 'vp' : cmd, useVp ? ['exec', ...args] : args, {
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

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function getSeasonDateRange(db: Client, season: string): Promise<{ start: Date; end: Date }> {
  const result = await db.execute({
    sql: `
      SELECT MIN(start_date) as first_date, MAX(start_date) as last_date
      FROM events
      WHERE season = ? OR year = ? OR start_date LIKE ?
    `,
    args: [season, season, `${season}%`],
  });
  const row = result.rows[0] as any;
  const firstDate = row?.first_date ? new Date(String(row.first_date)) : null;
  const lastDate = row?.last_date ? new Date(String(row.last_date)) : null;

  if (
    firstDate &&
    lastDate &&
    Number.isFinite(firstDate.getTime()) &&
    Number.isFinite(lastDate.getTime())
  ) {
    return { start: firstDate, end: lastDate };
  }

  // Fallback to hardcoded approximations
  const year = Number(season);
  return {
    start: new Date(Date.UTC(year, 5, 20)),
    end: new Date(Date.UTC(year, 7, 10)),
  };
}

const estimatePercentThrough = (date: Date, start: Date, end: Date) => {
  if (!Number.isFinite(date.getTime())) return 50;
  return Math.max(
    0,
    Math.min(
      100,
      ((date.getTime() - start.getTime()) / Math.max(1, end.getTime() - start.getTime())) * 100
    )
  );
};

async function findEvent(db: Client, season: string, eventText: string): Promise<EventRow> {
  const exact = await db.execute({
    sql: `
      SELECT event_id, slug, name, event_name, start_date, start_time, web_start_time, edt_start_time,
             timezone, location_city, location_state, event_image, event_image_thumb, buy_tickets,
             buy_tickets_text, live_stream_link, ticket_watermark, ticketing_map_image, street_map_image,
             description, meta_description, notes_general, notes_lineup_times, venue_city, venue_state,
             min_ticket_price, max_ticket_price
      FROM events
      WHERE (season = ? OR year = ? OR start_date LIKE ?)
        AND (slug = ? OR slug = ?)
      ORDER BY start_date ASC
      LIMIT 2
    `,
    args: [season, season, `${season}%`, eventText, slugify(eventText)],
  });
  if (exact.rows.length === 1) return exact.rows[0] as unknown as EventRow;

  const search = await db.execute({
    sql: `
      SELECT event_id, slug, name, event_name, start_date, start_time, web_start_time, edt_start_time,
             timezone, location_city, location_state, event_image, event_image_thumb, buy_tickets,
             buy_tickets_text, live_stream_link, ticket_watermark, ticketing_map_image, street_map_image,
             description, meta_description, notes_general, notes_lineup_times, venue_city, venue_state,
             min_ticket_price, max_ticket_price
      FROM events
      WHERE season = ? OR year = ? OR start_date LIKE ?
      ORDER BY start_date ASC
    `,
    args: [season, season, `${season}%`],
  });
  const needle = normalize(eventText);
  const matches = (search.rows as unknown as EventRow[]).filter(
    (row) =>
      normalize(row.slug).includes(needle) ||
      normalize(row.name ?? '').includes(needle) ||
      normalize(row.event_name ?? '').includes(needle)
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous event '${eventText}'. Matches:\n${matches
        .slice(0, 12)
        .map((row) => `  ${row.start_date} ${row.slug} (${row.event_name ?? row.name})`)
        .join('\n')}`
    );
  }
  throw new Error(
    `Event '${eventText}' not found for ${season}. Run with --refresh to ingest/scrape the schedule.`
  );
}

async function findCompetition(
  db: Client,
  season: string,
  event: EventRow
): Promise<CompetitionRow | undefined> {
  const candidates = await db.execute({
    sql: `
      SELECT slug, event_name, date, percent_through, scores_released, recap_released
      FROM competitions
      WHERE season = ?
        AND (
          slug = ?
          OR slug = ?
          OR date = ?
          OR lower(event_name) = lower(?)
          OR lower(event_name) = lower(?)
        )
      ORDER BY
        CASE WHEN slug = ? THEN 0 WHEN slug = ? THEN 1 WHEN date = ? THEN 2 ELSE 3 END,
        slug ASC
      LIMIT 1
    `,
    args: [
      season,
      event.slug,
      `${season}-${event.slug}`,
      event.start_date,
      event.event_name ?? event.name,
      event.name,
      event.slug,
      `${season}-${event.slug}`,
      event.start_date,
    ],
  });
  return candidates.rows[0] as unknown as CompetitionRow | undefined;
}

const NON_SCORING_RE =
  /welcome|national anthem|intermission|scores|encore|awards|gates open|presentation|event concludes?|event ends?|concludes?|closing|end of event|rhythm in blue|summer arts camp|flag line|en[-\s]?corps/i;

const dedupeLineupByCorpsKey = (rows: LineupRow[]) => {
  const byCorpsKey = new Map<string, LineupRow>();
  const result: LineupRow[] = [];
  for (const row of rows) {
    if (!row.corps_key) {
      result.push(row);
      continue;
    }
    const existing = byCorpsKey.get(row.corps_key);
    if (!existing) {
      byCorpsKey.set(row.corps_key, row);
      result.push(row);
      continue;
    }
    const existingIndex = result.indexOf(existing);
    const existingOrder = existing.performance_order ?? -1;
    const rowOrder = row.performance_order ?? -1;
    const preferred = rowOrder >= existingOrder ? row : existing;
    byCorpsKey.set(row.corps_key, preferred);
    if (existingIndex >= 0) result[existingIndex] = preferred;
  }
  return result;
};

const filterLineup = (rows: LineupRow[]) =>
  dedupeLineupByCorpsKey(
    rows.filter((row) => {
      // DB-backed corps/division identity wins. Text matching is only a fallback for
      // unresolved schedule markers from older or partially parsed lineup sources.
      if (row.division_name) return true;
      return !NON_SCORING_RE.test(row.unit_name);
    })
  );

async function loadLineup(db: Client, event: EventRow): Promise<LineupRow[]> {
  const fromScoredView = await db
    .execute({
      sql: `
      SELECT
        unit_name,
        COALESCE(display_city, canonical_display_city) AS display_city,
        time,
        performance_order,
        corps_key,
        participant_name,
        division_name
      FROM scored_event_lineup
      WHERE event_slug = ?
      ORDER BY COALESCE(performance_order, 999), time, unit_name
    `,
      args: [event.slug],
    })
    .catch(() => ({ rows: [] as unknown[] }));
  const scoredRows = fromScoredView.rows as unknown as LineupRow[];
  if (scoredRows.length) return filterLineup(scoredRows);

  const fromLineup = await db.execute({
    sql: `
      SELECT
        unit_name,
        display_city,
        time,
        performance_order,
        corps_key,
        participant_name,
        division_name
      FROM classified_event_lineup
      WHERE event_slug = ?
        AND effective_is_non_performance = 0
        AND is_non_corps = 0
        AND COALESCE(is_exhibition, 0) = 0
      ORDER BY COALESCE(performance_order, 999), time, unit_name
    `,
    args: [event.slug],
  });
  const rows = fromLineup.rows as unknown as LineupRow[];
  if (rows.length) return filterLineup(rows);

  const fromParticipants = await db.execute({
    sql: `
      SELECT
        COALESCE(ep.participant_name, c.name, ep.participant_slug, ep.corps_key) AS unit_name,
        COALESCE(c.display_city, c.city) AS display_city,
        NULL AS time,
        ep.performance_order,
        ep.corps_key,
        COALESCE(ep.participant_name, c.name) AS participant_name,
        c.division_name
      FROM event_participants ep
      LEFT JOIN corps c ON c.corps_key = ep.corps_key
      WHERE ep.event_slug = ?
      ORDER BY COALESCE(ep.performance_order, 999), unit_name
    `,
    args: [event.slug],
  });
  const participantRows = fromParticipants.rows as unknown as LineupRow[];
  if (participantRows.length) return filterLineup(participantRows);

  const fromSchedule = await db.execute({
    sql: `
      SELECT
        es.unit_name,
        es.display_city,
        es.time,
        es.performance_order,
        c.corps_key,
        c.name AS participant_name,
        c.division_name
      FROM event_schedules es
      LEFT JOIN corps c
        ON lower(c.name) = lower(es.unit_name)
        OR lower(c.slug) = lower(replace(es.unit_name, ' ', '-'))
      WHERE es.event_id = ?
      ORDER BY COALESCE(es.performance_order, 999), es.time, es.unit_name
    `,
    args: [event.event_id],
  });
  return filterLineup(fromSchedule.rows as unknown as LineupRow[]);
}

const championshipFallbackSpec = (
  event: EventRow
): {
  // Ordered cascade of prior-season rounds to draw the field from: the round
  // itself first, then progressively deeper rounds to backfill any slots freed
  // by corps that aren't competing this season. A championship round has a fixed
  // size (Finals = 12), so if a prior finalist is on hiatus we promote the next
  // active corps from semifinals, semifinals backfills from prelims, and so on.
  sourceSlugLikes: string[];
  excludeOpenClass: boolean;
  maxRank: number;
  division: 'World Class' | 'Open Class';
  source: LineupSource;
} | null => {
  const haystack = normalize(`${event.slug} ${event.event_name ?? ''} ${event.name ?? ''}`);
  if (!haystack.includes('championship')) return null;

  const isOpenClass = haystack.includes('open class');
  const division = isOpenClass ? 'Open Class' : 'World Class';
  const divisionSource = isOpenClass ? 'open' : 'world';
  const roundLike = (round: string) =>
    isOpenClass ? `%open-class%world-championship%${round}%` : `%dci-world-championship-${round}%`;

  // Check semifinals/prelims before finals: "semifinals" contains "finals", so a
  // bare finals test would mis-route semifinal events into the finals branch.
  if (
    (haystack.includes('finals') || haystack.includes('final')) &&
    !haystack.includes('semifinal')
  ) {
    return {
      sourceSlugLikes: [roundLike('finals'), roundLike('semifinals'), roundLike('prelims')],
      excludeOpenClass: !isOpenClass,
      maxRank: isOpenClass ? 25 : 12,
      division,
      source: `prior_season_${divisionSource}_finals` as LineupSource,
    };
  }
  if (haystack.includes('semifinals') || haystack.includes('semifinal')) {
    return {
      sourceSlugLikes: [roundLike('semifinals'), roundLike('prelims')],
      excludeOpenClass: !isOpenClass,
      maxRank: 25,
      division,
      source: `prior_season_${divisionSource}_semifinals` as LineupSource,
    };
  }
  if (haystack.includes('prelims') || haystack.includes('prelim')) {
    return {
      sourceSlugLikes: [roundLike('prelims')],
      excludeOpenClass: !isOpenClass,
      maxRank: isOpenClass ? 35 : 40,
      division,
      source: `prior_season_${divisionSource}_prelims` as LineupSource,
    };
  }

  return null;
};

async function loadPriorSeasonChampionshipLineup(
  db: Client,
  event: EventRow,
  priorSeason: string,
  currentSeason: string
): Promise<{ rows: LineupRow[]; source: LineupSource } | null> {
  const spec = championshipFallbackSpec(event);
  if (!spec) return null;

  // The championship lineup isn't known until the season plays out, so we seed
  // the forecast field from prior-season results, restricted to corps actually
  // competing this season (a corps on hiatus like the Mandarins in 2026 ranked
  // last year but won't be on the field). Walk the cascade (the round, then
  // deeper rounds) accumulating distinct active corps until the round's fixed
  // size is met — so a vacated slot is filled by the next active corps from the
  // next round down rather than shrinking the field.
  const queryRound = (slugLike: string) =>
    db.execute({
      sql: `
        SELECT
          cs.corps_name AS unit_name,
          COALESCE(c.display_city, c.city) AS display_city,
          NULL AS time,
          cs.rank AS performance_order,
          cs.corps_key,
          cs.corps_name AS participant_name,
          cs.division_name
        FROM corps_scores cs
        JOIN competitions comp ON comp.slug = cs.competition_slug
        LEFT JOIN corps c ON c.corps_key = cs.corps_key
        WHERE comp.season = ?
          AND lower(comp.slug) LIKE '%world-championship%'
          AND lower(comp.slug) LIKE ?
          AND (? = 0 OR lower(comp.slug) NOT LIKE '%open-class%')
          AND lower(comp.slug) NOT LIKE '%all-age%'
          AND cs.division_name = ?
          AND cs.total_score > 0
          AND EXISTS (
            SELECT 1 FROM scored_event_lineup sel
            JOIN events ev ON ev.slug = sel.event_slug
            WHERE ev.season = ? AND sel.corps_key = cs.corps_key
          )
        ORDER BY cs.rank ASC, cs.total_score DESC, cs.corps_name ASC
      `,
      args: [priorSeason, slugLike, spec.excludeOpenClass ? 1 : 0, spec.division, currentSeason],
    });

  const seen = new Set<string>();
  const acc: LineupRow[] = [];
  for (const slugLike of spec.sourceSlugLikes) {
    if (acc.length >= spec.maxRank) break;
    const result = await queryRound(slugLike);
    for (const row of filterLineup(result.rows as unknown as LineupRow[])) {
      if (acc.length >= spec.maxRank) break;
      const dedupeKey = row.corps_key ?? `name:${row.unit_name}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // Renumber seed position 1..N across the cascade so a promoted corps slots
      // into the freed rank rather than carrying its deeper-round rank.
      acc.push({ ...row, performance_order: acc.length + 1 });
    }
  }
  return acc.length ? { rows: acc, source: spec.source } : null;
}

async function loadLineupAudit(db: Client, eventSlug: string) {
  const readiness = await db
    .execute({
      sql: `
      SELECT *
      FROM event_prediction_readiness
      WHERE event_slug = ?
      LIMIT 1
    `,
      args: [eventSlug],
    })
    .catch(() => ({ rows: [] as unknown[] }));
  const exclusions = await db
    .execute({
      sql: `
      SELECT unit_name, performance_order, exclusion_reason
      FROM event_lineup_exclusions
      WHERE event_slug = ?
      ORDER BY COALESCE(performance_order, 999), unit_name
    `,
      args: [eventSlug],
    })
    .catch(() => ({ rows: [] as unknown[] }));
  return {
    readiness: readiness.rows[0] ?? null,
    exclusions: exclusions.rows,
  };
}

// Stamps the canonical signature on a saved run; the app recomputes the same
// shape via eventPredictionInputSignature to decide freshness (review Medium #5).
const predictionInputSignature = (input: {
  event: EventRow;
  lineup: LineupRow[];
  modelDir: string;
  modelFingerprint: string | undefined;
  modelStaticDim: number;
  featureStaticDim: number;
  mode: string;
  division: string;
  percentThrough: number;
  sameSeasonHistory: number;
  judgeAssignments: number;
  sameSeasonBreakdownPrior: boolean;
  builderVersion: string;
}) =>
  eventPredictionInputSignature({
    eventSlug: input.event.slug,
    startDate: input.event.start_date,
    lineup: input.lineup.map((row) => ({
      corps_key: row.corps_key,
      unit_name: row.unit_name,
      order: row.performance_order,
      time: row.time,
      division: row.division_name,
    })),
    modelDir: input.modelDir,
    modelFingerprint: input.modelFingerprint,
    modelStaticDim: input.modelStaticDim,
    featureStaticDim: input.featureStaticDim,
    mode: input.mode,
    division: input.division,
    percentThrough: input.percentThrough,
    sameSeasonHistory: input.sameSeasonHistory,
    judgeAssignments: input.judgeAssignments,
    sameSeasonBreakdownPrior: input.sameSeasonBreakdownPrior,
    builderVersion: input.builderVersion,
  });

const modelFileFingerprint = (modelDir: string) => {
  const modelPath = path.join(modelDir, 'model.json');
  const weightsPath = path.join(modelDir, 'weights.bin');
  if (!fs.existsSync(modelPath)) return undefined;
  const modelStat = fs.statSync(modelPath);
  const weightsStat = fs.existsSync(weightsPath) ? fs.statSync(weightsPath) : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        model_json_mtime_ms: Math.round(modelStat.mtimeMs),
        model_json_size: modelStat.size,
        weights_mtime_ms: weightsStat ? Math.round(weightsStat.mtimeMs) : null,
        weights_size: weightsStat?.size ?? null,
      })
    )
    .digest('hex');
};

const loadIntervalScale = (modelDir: string) => {
  for (const fileName of ['model-card.json', 'test-results.json', 'eval_report.json']) {
    const filePath = path.join(modelDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const scale = Number(parsed?.interval_calibration?.selected?.scale);
      if (Number.isFinite(scale) && scale > 0 && scale <= 1.5) return scale;
    } catch {
      // Optional metadata only; fall through to the conservative default.
    }
  }
  return 0.65;
};

async function loadJudgeIndices(db: Client, competitionSlug: string | undefined) {
  if (!competitionSlug) return { indices: new Array(CAPTIONS.length).fill(0), known: 0 };
  const map = fs.existsSync('src/training/judgeIndexMap.json')
    ? (JSON.parse(fs.readFileSync('src/training/judgeIndexMap.json', 'utf-8')) as Record<
        string,
        number
      >)
    : {};
  const rows = await db.execute({
    sql: `
      SELECT normalized_caption_name, judge_id
      FROM judge_assignments
      WHERE competition_slug = ?
    `,
    args: [competitionSlug],
  });
  const indices = new Array(CAPTIONS.length).fill(0);
  for (const row of rows.rows as unknown as Array<{
    normalized_caption_name: string;
    judge_id: string;
  }>) {
    const slot = captionToJudgeIndexSlot[row.normalized_caption_name];
    if (slot != null) indices[slot] = map[row.judge_id] ?? 0;
  }
  return { indices, known: indices.filter((idx) => idx > 0).length };
}

async function countSameSeasonHistory(db: Client, season: string, targetDate: string) {
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS count FROM ml_sequence_rows_v9_subcaption WHERE season = ? AND competition_date < ?',
    args: [season, targetDate],
  });
  return Number((result.rows[0] as any)?.count ?? 0);
}

/**
 * This CORPS' observed shows so far this season. NOTE: features.observedHistoryLen
 * can't stand in for this — in non-preseason modes the feature template falls back
 * to the corps' latest row from ANY season (typically last year's finals), so a
 * corps that hasn't competed yet still reports a non-zero history length.
 */
async function countCorpsSameSeasonShows(
  db: Client,
  corpsKey: string,
  season: string,
  targetDate: string
) {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM ml_sequence_rows_v9_subcaption
          WHERE season = ? AND corps_key = ? AND competition_date < ?`,
    args: [season, corpsKey, targetDate],
  });
  return Number((result.rows[0] as any)?.count ?? 0);
}

async function getPriorSeasonFinalRank(
  db: Client,
  corpsKey: string,
  priorSeason: string,
  division?: string
): Promise<number | undefined> {
  const allAge = isAllAgeDivision(division);
  const result = await db.execute({
    sql: `
      SELECT
        ${allAge ? 'ccr.corps_rank AS rank' : 'cs.rank AS rank'},
        ${allAge ? 'ccr.competition_date AS date' : 'comp.date AS date'}
      FROM ${allAge ? 'corps_competition_results ccr' : 'corps_scores cs JOIN competitions comp ON comp.slug = cs.competition_slug'}
      WHERE ${allAge ? 'ccr.corps_key' : 'cs.corps_key'} = ?
        AND ${allAge ? 'ccr.season' : 'comp.season'} = ?
        AND ${
          allAge
            ? "(ccr.competition_slug LIKE '%championship%' OR ccr.event_name LIKE '%championship%')"
            : "comp.slug LIKE '%finals%'"
        }
      ORDER BY date DESC
      LIMIT 1
    `,
    args: [corpsKey, priorSeason],
  });
  const rank = (result.rows[0] as any)?.rank;
  return rank != null ? Number(rank) : undefined;
}

async function getPriorSeasonComparableTotal(
  db: Client,
  corpsKey: string,
  priorSeason: string,
  targetPercentThrough: number
): Promise<PriorSeasonComparable | undefined> {
  const result = await db.execute({
    sql: `
      SELECT cs.total_score, comp.percent_through, comp.date, comp.slug
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
      WHERE cs.corps_key = ?
        AND comp.season = ?
        AND cs.total_score > 0
        AND cs.total_score <= 100
      ORDER BY
        ABS(COALESCE(comp.percent_through, 50) - ?) ASC,
        comp.date ASC
      LIMIT 1
    `,
    args: [corpsKey, priorSeason, targetPercentThrough],
  });
  const row = result.rows[0] as any;
  const total = row?.total_score;
  const matchedPercent = row?.percent_through == null ? 50 : Number(row.percent_through);
  if (targetPercentThrough <= 5 && matchedPercent > 10) {
    return undefined;
  }
  return total != null
    ? {
        total: Number(total),
        percentThrough: matchedPercent,
        date: String(row.date ?? ''),
        competitionSlug: String(row.slug ?? ''),
      }
    : undefined;
}

async function resolveHistoricalCorpsKey(
  db: Client,
  entry: LineupRow,
  priorSeason: string
): Promise<string> {
  const currentKey = entry.corps_key ?? slugify(entry.unit_name);
  const existing = await db.execute({
    sql: `
      SELECT 1
      FROM corps_competition_results
      WHERE season = ?
        AND corps_key = ?
      LIMIT 1
    `,
    args: [priorSeason, currentKey],
  });
  if (existing.rows.length > 0) return currentKey;

  const targetName = normalizeName(entry.unit_name);
  if (!targetName) return currentKey;
  const candidates = await db.execute({
    sql: `
      SELECT corps_key, corps_name, COUNT(*) AS count
      FROM corps_competition_results
      WHERE season = ?
        AND division_name LIKE '%Age%'
      GROUP BY corps_key, corps_name
      ORDER BY count DESC
    `,
    args: [priorSeason],
  });
  const match = candidates.rows.find((row: any) => {
    const candidateName = normalizeName(String(row.corps_name ?? ''));
    return candidateName === targetName || candidateName.includes(targetName) || targetName.includes(candidateName);
  }) as any | undefined;
  return match?.corps_key ? String(match.corps_key) : currentKey;
}

async function getPriorSeasonComparableRecap(
  db: Client,
  corpsKey: string,
  priorSeason: string,
  targetPercentThrough: number
): Promise<PriorSeasonComparable | undefined> {
  const result = await db.execute({
    sql: `
      SELECT competition_slug, event_name, competition_date, percent_through, total_score
      FROM corps_competition_results
      WHERE corps_key = ?
        AND season = ?
        AND total_score > 0
        AND total_score <= 100
      ORDER BY
        ABS(COALESCE(percent_through, 50) - ?) ASC,
        competition_date ASC
      LIMIT 1
    `,
    args: [corpsKey, priorSeason, targetPercentThrough],
  });
  const row = result.rows[0] as any;
  if (!row) return undefined;
  const matchedPercent = row.percent_through == null ? 50 : Number(row.percent_through);
  if (targetPercentThrough <= 5 && matchedPercent > 10) return undefined;

  const captionRows = await db.execute({
    sql: `
      SELECT caption_initials, score
      FROM caption_scores
      WHERE competition_slug = ?
        AND corps_key = ?
    `,
    args: [String(row.competition_slug), corpsKey],
  });
  const captions = Object.fromEntries(CAPTIONS.map((caption) => [caption, 0])) as Record<
    Caption,
    number
  >;
  for (const captionRow of captionRows.rows as any[]) {
    const key = String(captionRow.caption_initials ?? '').replace(/\s+/g, '') as Caption;
    if ((CAPTIONS as readonly string[]).includes(key)) {
      captions[key] = Number(captionRow.score ?? 0);
    }
  }

  return {
    total: Number(row.total_score),
    percentThrough: matchedPercent,
    date: String(row.competition_date ?? ''),
    competitionSlug: String(row.competition_slug ?? ''),
    captions: Object.values(captions).some((value) => value > 0) ? captions : undefined,
  };
}

type SameSeasonPriorCompetitionRow = {
  competition_slug: string;
  competition_date: string;
};

const normalizeCaptionInitials = (value: unknown): V9BreakdownCaption | undefined => {
  const normalized = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  return (V9_BREAKDOWN_CAPTIONS as readonly string[]).includes(normalized)
    ? (normalized as V9BreakdownCaption)
    : undefined;
};

const meanNumber = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const stdNumber = (values: readonly number[], average: number) => {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
};

const daysBetween = (from: string, to: string) => {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, (toMs - fromMs) / (24 * 60 * 60 * 1000));
};

async function loadSameSeasonBreakdownPriors(
  db: Client,
  input: {
    corpsKey: string;
    season: string;
    targetDate: string;
    emaAlpha?: number;
  }
): Promise<Partial<Record<V9BreakdownCaption, V9BreakdownPriorShare>>> {
  const priorCompetitions = await db.execute({
    sql: `
      SELECT cs.competition_slug, comp.date AS competition_date
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
      WHERE cs.corps_key = ?
        AND comp.season = ?
        AND comp.date < ?
      ORDER BY comp.date ASC, cs.competition_slug ASC
    `,
    args: [input.corpsKey, input.season, input.targetDate],
  });
  const competitions = priorCompetitions.rows as unknown as SameSeasonPriorCompetitionRow[];
  if (!competitions.length) return {};

  const sharesByCaption = Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption) => [caption, []])
  ) as Record<V9BreakdownCaption, Array<{ share: number; date: string }>>;

  for (const competition of competitions) {
    const captionRows = await db.execute({
      sql: `
        SELECT caption_initials, score
        FROM caption_scores
        WHERE competition_slug = ?
          AND corps_key = ?
      `,
      args: [competition.competition_slug, input.corpsKey],
    });
    const captionTotals: Partial<Record<V9BreakdownCaption, number>> = {};
    for (const row of captionRows.rows as any[]) {
      const caption = normalizeCaptionInitials(row.caption_initials);
      if (caption) captionTotals[caption] = Number(row.score);
    }
    if (!Object.keys(captionTotals).length) continue;

    const subcaptionRows = await db.execute({
      sql: `
        SELECT competition_slug, corps_key, caption_name, judge_id, subcaption_name, score
        FROM subcaption_scores
        WHERE competition_slug = ?
          AND corps_key = ?
      `,
      args: [competition.competition_slug, input.corpsKey],
    });
    const aggregate = aggregateV9BreakdownSubcaptions(
      (subcaptionRows.rows as any[]).map(
        (row): V9BreakdownSubcaptionRow => ({
          competition_slug: String(row.competition_slug),
          corps_key: String(row.corps_key),
          caption_name: String(row.caption_name),
          judge_id: row.judge_id == null ? null : String(row.judge_id),
          subcaption_name: String(row.subcaption_name),
          score: Number(row.score),
        })
      ),
      captionTotals as Record<string, number>
    );

    for (const caption of V9_BREAKDOWN_CAPTIONS) {
      if (!aggregate.mask[caption].pair) continue;
      const pair = aggregate.target[caption];
      const total = pair.content + pair.achievement;
      if (total <= 0) continue;
      const share = pair.content / total;
      if (!Number.isFinite(share) || share < 0.48 || share > 0.54) continue;
      sharesByCaption[caption].push({ share, date: String(competition.competition_date) });
    }
  }

  const emaAlpha = input.emaAlpha ?? 0.55;
  const priors: Partial<Record<V9BreakdownCaption, V9BreakdownPriorShare>> = {};
  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    const values = sharesByCaption[caption];
    if (!values.length) continue;
    const shares = values.map((entry) => entry.share);
    const meanShare = meanNumber(shares);
    const emaShare = shares.reduce(
      (ema, share, idx) => (idx === 0 ? share : ema * (1 - emaAlpha) + share * emaAlpha),
      shares[0]!
    );
    const latest = values[values.length - 1]!;
    priors[caption] = {
      count: values.length,
      meanShare,
      emaShare,
      latestShare: latest.share,
      stdShare: stdNumber(shares, meanShare),
      latestDate: latest.date,
      daysSinceLatest: daysBetween(latest.date, input.targetDate),
    };
  }
  return priors;
}

const totalFromCaps = (caps: Record<Caption, number>) =>
  caps.GE1 + caps.GE2 + (caps.VP + caps.VA + caps.CG) / 2 + (caps.MB + caps.MA + caps.MP) / 2;

const scaleCapsToTotal = (
  caps: Record<Caption, number>,
  targetTotal: number
): Record<Caption, number> => {
  const currentTotal = totalFromCaps(caps);
  if (
    !Number.isFinite(currentTotal) ||
    currentTotal <= 0 ||
    !Number.isFinite(targetTotal) ||
    targetTotal <= 0
  ) {
    return caps;
  }
  const scale = targetTotal / currentTotal;
  return Object.fromEntries(
    CAPTIONS.map((caption) => [
      caption,
      Number(Math.max(0, Math.min(20, caps[caption] * scale)).toFixed(3)),
    ])
  ) as Record<Caption, number>;
};

const reconcileCapsToTotalPreservingShape = (
  caps: Record<Caption, number>,
  targetTotal: number
): Record<Caption, number> => {
  const currentTotal = totalFromCaps(caps);
  if (!Number.isFinite(currentTotal) || !Number.isFinite(targetTotal) || targetTotal <= 0) {
    return caps;
  }
  const totalWeight = 5; // GE1 + GE2 + half of six Visual/Music subcaptions.
  const perCaptionShift = (targetTotal - currentTotal) / totalWeight;
  const shifted = Object.fromEntries(
    CAPTIONS.map((caption) => [caption, Math.max(0, Math.min(20, caps[caption] + perCaptionShift))])
  ) as Record<Caption, number>;

  // If clipping near 0/20 prevented the additive pass from landing exactly, use
  // a tiny final scale as a fallback. Normal finals/preseason predictions should
  // not hit this branch.
  const shiftedTotal = totalFromCaps(shifted);
  const finalCaps =
    Math.abs(shiftedTotal - targetTotal) > 0.01 ? scaleCapsToTotal(shifted, targetTotal) : shifted;
  return Object.fromEntries(
    CAPTIONS.map((caption) => [caption, Number(finalCaps[caption].toFixed(3))])
  ) as Record<Caption, number>;
};

const alignCapsToTotal = (caps: Record<Caption, number>, targetTotal: number) =>
  reconcileCapsToTotalPreservingShape(caps, targetTotal);

const captionShapeModelWeight = (input: {
  mode: PredictionContextMode;
  supportsCaptionFingerprints: boolean;
  historyLen: number;
  hasHistoricalTemplate: boolean;
}) => {
  const { mode, supportsCaptionFingerprints, historyLen, hasHistoricalTemplate } = input;
  if (!supportsCaptionFingerprints || !hasHistoricalTemplate) return 0;
  if (mode === 'preseason_forecast') return 0.25;
  if (historyLen >= 5) return 0.45;
  if (historyLen >= 3) return 0.35;
  return 0.25;
};

const preseasonComparableWeight = (
  targetPercentThrough: number,
  comparablePercentThrough: number
) => {
  const distance = Math.abs(targetPercentThrough - comparablePercentThrough);
  const progressWeight =
    targetPercentThrough <= 5 ? 0.35 : targetPercentThrough <= 20 ? 0.45 : 0.55;
  const distancePenalty = distance <= 2 ? 0 : distance <= 5 ? 0.1 : 0.2;
  return Math.max(0.2, Math.min(0.55, progressWeight - distancePenalty));
};

const blendCaps = (
  modelCaps: Record<Caption, number>,
  baselineCaps: Record<Caption, number>,
  modelWeight: number
): Record<Caption, number> =>
  Object.fromEntries(
    CAPTIONS.map((caption) => {
      const blended =
        baselineCaps[caption] + (modelCaps[caption] - baselineCaps[caption]) * modelWeight;
      return [caption, Number(Math.max(0, Math.min(20, blended)).toFixed(3))];
    })
  ) as Record<Caption, number>;

const modelWeightForHistory = (historyLen: number) => {
  if (historyLen >= 5) return 0.65;
  if (historyLen >= 3) return 0.8;
  return 1;
};

const chooseMode = (
  cli: Cli,
  sameSeasonHistory: number,
  judgeCount: number
): PredictionContextMode => {
  if (cli.mode !== 'auto') return cli.mode;
  if (sameSeasonHistory <= 0) return 'preseason_forecast';
  if (judgeCount < CAPTIONS.length) return 'panel_unknown';
  return 'as_of_show_date';
};

const printReadiness = (args: {
  event: EventRow;
  competition?: CompetitionRow;
  lineup: LineupRow[];
  lineupSource: LineupSource;
  judgeCount: number;
  mode: PredictionContextMode;
  percentThrough: number;
}) => {
  const { event, competition, lineup, lineupSource, judgeCount, mode, percentThrough } = args;
  const location = [event.location_city, event.location_state].filter(Boolean).join(', ') || '?';
  const time = event.start_time ?? event.web_start_time ?? event.edt_start_time ?? '?';
  const corpsRows = lineup.filter((row) => row.corps_key);
  console.log(`\nEvent: ${event.event_name ?? event.name}`);
  console.log(`Slug: ${event.slug}`);
  console.log(`Date/time: ${event.start_date} ${time} ${event.timezone ?? ''}`.trim());
  console.log(`Location: ${location}`);
  console.log(`Competition: ${competition?.slug ?? 'not found'}`);
  console.log(
    `Lineup rows: ${lineup.length}; matched corps keys: ${corpsRows.length}; source=${lineupSource}`
  );
  console.log(`Judge assignments: ${judgeCount}/${CAPTIONS.length}`);
  console.log(`Prediction mode: ${mode}`);
  console.log(`Percent through season: ${percentThrough.toFixed(1)}`);
  if (!lineup.length) console.log('Lineup missing. Run with --refresh or --force-refresh.');
  if (lineupSource !== 'event_lineup')
    console.log('Lineup is estimated from the prior-season championship field.');
  if (judgeCount < CAPTIONS.length)
    console.log('Judges incomplete/missing. Prediction will use panel-unknown behavior.');
};

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
      '--skip-recaps',
      '--skip-ml',
      // Predictions don't need the corps/logo refresh (scrapeCorps + flagDarkLogos,
      // the latter needs `sharp`). Skip it so prediction generation doesn't depend
      // on image tooling.
      '--skip-corps',
    ];
    if (cli.forceRefresh) args.push('--force');
    await runCommand('npx', args);
  }

  const db = createClient({ url: cli.db });
  try {
    const event = await findEvent(db, cli.season, cli.event);
    const competition = await findCompetition(db, cli.season, event);
    const priorSeason = String(Number(cli.season) - 1);
    let lineup = await loadLineup(db, event);
    let lineupSource: LineupSource = 'event_lineup';
    // A championship event page only ever lists a ceremony schedule + exhibition
    // acts (Gates Open, National Anthem, "Competition Resumes", a service corps,
    // …) — never the competitive field, which isn't known until the season plays
    // out. Those rows don't resolve to a real competitive corps, so fall back to
    // the prior-season finalist template (active corps only) whenever the scraped
    // lineup has no real corps — not just when it's empty.
    const hasRealCorps = lineup.some((row) => row.corps_key && row.division_name);
    if (!hasRealCorps) {
      const fallback = await loadPriorSeasonChampionshipLineup(db, event, priorSeason, cli.season);
      if (fallback) {
        lineup = fallback.rows;
        lineupSource = fallback.source;
      }
    }
    const sameSeasonHistory = await countSameSeasonHistory(db, cli.season, event.start_date);
    const judgeInfo = await loadJudgeIndices(db, competition?.slug);
    const mode = chooseMode(cli, sameSeasonHistory, judgeInfo.known);
    const seasonRange = await getSeasonDateRange(db, cli.season);
    const percentThrough =
      cli.percentThrough ??
      competition?.percent_through ??
      estimatePercentThrough(new Date(event.start_date), seasonRange.start, seasonRange.end);
    printReadiness({
      event,
      competition,
      lineup,
      lineupSource,
      judgeCount: judgeInfo.known,
      mode,
      percentThrough,
    });

    if (cli.checkOnly) return;
    if (!lineup.length)
      throw new Error(
        'Cannot predict without lineup rows. Run with --refresh or provide schedule/lineup data first.'
      );

    const modelDir =
      cli.modelDir === 'latest' || !cli.modelDir ? findLatestV9SubcaptionModelDir() : cli.modelDir;
    if (!modelDir) throw new Error('No V9 model found. Pass --model-dir <path>.');
    const model = await (async () => {
      const { loadV9SubcaptionModel } = await import('../src/training/v9SubcaptionInference.js');
      return loadV9SubcaptionModel(modelDir);
    })();
    const breakdownSplitCurves = loadBreakdownSplitCurves(cli.breakdownSplitCurves);
    if (breakdownSplitCurves) {
      console.log(`Breakdown split curves: ${cli.breakdownSplitCurves}`);
    }
    const modelStaticDim = model.staticFeatureDim;
    const supportsCaptionFingerprints = modelStaticDim >= V9_RAW_STATIC_DIM;
    const modelFingerprint = modelFileFingerprint(modelDir);
    const intervalScale = loadIntervalScale(modelDir);
    const builderVersion = 'v10-event-prediction-all-age-baselines';
    const lineupAudit = await loadLineupAudit(db, event.slug);
    const inputSignature = predictionInputSignature({
      event,
      lineup,
      modelDir,
      modelFingerprint,
      modelStaticDim,
      featureStaticDim: V9_RAW_STATIC_DIM,
      mode,
      division: cli.division,
      percentThrough,
      sameSeasonHistory,
      judgeAssignments: judgeInfo.known,
      sameSeasonBreakdownPrior: cli.sameSeasonBreakdownPrior,
      builderVersion,
    });

    const sortedLineup = [...lineup].sort(
      (a, b) =>
        (a.performance_order ?? 999) - (b.performance_order ?? 999) ||
        String(a.time ?? '').localeCompare(String(b.time ?? '')) ||
        a.unit_name.localeCompare(b.unit_name)
    );
    const supportedLineup = sortedLineup.filter((entry) => {
      const division = predictionDivision(cli, entry);
      return isSupportedPredictionDivision(division);
    });
    const fieldSize = Math.max(1, supportedLineup.length);
    const priorSeasonRanks = new Map<string, number>();
    for (const entry of sortedLineup) {
      const division = predictionDivision(cli, entry);
      if (!isSupportedPredictionDivision(division)) continue;
      const corpsKey = await resolveHistoricalCorpsKey(db, entry, priorSeason);
      const priorRank = await getPriorSeasonFinalRank(db, corpsKey, priorSeason, division);
      if (priorRank != null) priorSeasonRanks.set(corpsKey, priorRank);
    }
    const fieldSeedRanks = new Map<string, number>();
    [...priorSeasonRanks.entries()]
      .sort((a, b) => a[1] - b[1])
      .forEach(([corpsKey], idx) => fieldSeedRanks.set(corpsKey, idx + 1));
    const rows = [];
    const skippedRows = [];
    for (let idx = 0; idx < sortedLineup.length; idx++) {
      const entry = sortedLineup[idx]!;
      // Do not infer seed rank from performance order; let the baseline system use historical template data or default to neutral.
      const division = predictionDivision(cli, entry);
      if (!isSupportedPredictionDivision(division)) {
        skippedRows.push({
          corps_key: entry.corps_key,
          corps: entry.unit_name,
          division,
          performance_order: entry.performance_order,
          time: entry.time,
          reason: 'unsupported division for V9 model',
        });
        continue;
      }
      const corpsKey = await resolveHistoricalCorpsKey(db, entry, priorSeason);
      const priorSeasonRank = priorSeasonRanks.get(corpsKey);
      const seedRank = mode === 'preseason_forecast' ? fieldSeedRanks.get(corpsKey) : undefined;
      // Fetched in EVERY mode for World/Open (not just preseason): in-season, a
      // corps that hasn't competed yet has no same-season history to ground the
      // model, and without this anchor its prediction collapses to the raw
      // prior-season-finals baseline (~20 points high in early July). Whether the
      // anchor is APPLIED is decided below (preseason, or zero observed history).
      const priorSeasonComparable = isAllAgeDivision(division)
        ? mode === 'preseason_forecast'
          ? await getPriorSeasonComparableRecap(db, corpsKey, priorSeason, percentThrough)
          : undefined
        : await getPriorSeasonComparableTotal(db, corpsKey, priorSeason, percentThrough);
      const sameSeasonBreakdownPriors =
        cli.sameSeasonBreakdownPrior && breakdownSplitCurves
          ? await loadSameSeasonBreakdownPriors(db, {
              corpsKey,
              season: cli.season,
              targetDate: event.start_date,
            })
          : undefined;
      const features = await buildV9PredictionFeatures(db, {
        mode,
        corpsKey,
        division,
        targetDate: event.start_date,
        percentThrough,
        season: cli.season,
        fieldSize,
        seedRank,
        priorSeasonRank,
        judgeIndices: judgeInfo.known === CAPTIONS.length ? judgeInfo.indices : undefined,
        keepKnownLineupContext: mode !== 'lineup_unknown',
      });
      const prediction = model.predictOne({
        sequence: features.sequence,
        staticFeatures: features.staticFeatures,
        judgeIndices: features.judgeIndices,
        corpsId: features.corpsId,
        baselineRecap: features.baselineRecap,
        historyLen: features.observedHistoryLen,
        judgeBiasScale: features.judgeBiasScale,
        corpsScale: features.corpsScale,
        agnosticShowId: features.agnosticShowId,
      });

      // Preseason predictions use baseline/fingerprint totals, with a limited
      // model contribution for caption shape when a historical corps template exists.
      const useBaseline = mode === 'preseason_forecast';
      const rawCaps = Object.fromEntries(
        CAPTIONS.map((caption) => [caption, Number(prediction.captions[caption].p50.toFixed(3))])
      ) as Record<Caption, number>;
      const rawIntervals = Object.fromEntries(
        CAPTIONS.map((caption) => {
          const interval = prediction.captions[caption];
          return [
            caption,
            {
              low_offset: Number(((interval.p10 - interval.p50) * intervalScale).toFixed(3)),
              high_offset: Number(((interval.p90 - interval.p50) * intervalScale).toFixed(3)),
            },
          ];
        })
      ) as Record<Caption, { low_offset: number; high_offset: number }>;
      const baselineCaps = Object.fromEntries(
        CAPTIONS.map((caption, captionIdx) => [
          caption,
          Number(
            (
              priorSeasonComparable?.captions?.[caption] ??
              features.baselineRecap[captionIdx] ??
              features.baseline.captions[caption]
            ).toFixed(3)
          ),
        ])
      ) as Record<Caption, number>;
      const historyLen = features.observedHistoryLen;
      const modelWeight = useBaseline ? 0 : modelWeightForHistory(historyLen);
      const baselineTotal = totalFromV9Captions(baselineCaps);
      const shapeModelWeight = useBaseline
        ? captionShapeModelWeight({
            mode,
            supportsCaptionFingerprints,
            historyLen,
            hasHistoricalTemplate: features.provenance.template.source === 'historical_template',
          })
        : modelWeight;
      const modelShapeCaps = alignCapsToTotal(rawCaps, baselineTotal);
      const pointCaps = useBaseline
        ? blendCaps(modelShapeCaps, baselineCaps, shapeModelWeight)
        : blendCaps(rawCaps, baselineCaps, modelWeight);
      // Anchor to the corps' prior-season total at a comparable percent-through
      // when we have nothing better: preseason (always), or in-season for a corps
      // with NO observed same-season shows yet — otherwise its point total is the
      // raw prior-season-finals baseline, ~20 points high in early July. Once the
      // corps has real 2026 scores, the model's sequence input grounds it and the
      // anchor turns off.
      const corpsSameSeasonShows = await countCorpsSameSeasonShows(
        db,
        corpsKey,
        cli.season,
        event.start_date
      );
      const anchorToComparable =
        priorSeasonComparable && (useBaseline || corpsSameSeasonShows === 0);
      // In-season cold corps (and all-age) anchor mostly to the comparable: their
      // baselineTotal is FINALS-scaled (the template is last year's final recap),
      // unlike preseason's percent-scaled fingerprint baseline — leaving 45% of a
      // finals-level total in the blend re-inflates the prediction.
      const comparableDominates =
        isAllAgeDivision(division) || (!useBaseline && corpsSameSeasonShows === 0);
      const comparableWeight =
        anchorToComparable && priorSeasonComparable
          ? comparableDominates
            ? Math.max(
                0.85,
                preseasonComparableWeight(percentThrough, priorSeasonComparable.percentThrough)
              )
            : preseasonComparableWeight(percentThrough, priorSeasonComparable.percentThrough)
          : 0;
      const preseasonTargetTotal =
        anchorToComparable && priorSeasonComparable
          ? baselineTotal * (1 - comparableWeight) + priorSeasonComparable.total * comparableWeight
          : undefined;
      const pointCapsTotal = totalFromV9Captions(pointCaps);
      const caps =
        preseasonTargetTotal != null
          ? reconcileCapsToTotalPreservingShape(pointCaps, preseasonTargetTotal)
          : pointCaps;
      const finalTotal = totalFromV9Captions(caps);
      const predictedScoreBreakdown = breakdownSplitCurves
        ? splitV9RecapWithCurvesAndPrior(breakdownSplitCurves, {
            divisionName: division,
            percentThroughSeason: percentThrough,
            captions: caps,
            priors: sameSeasonBreakdownPriors,
            priorBlendConfig: { enabled: cli.sameSeasonBreakdownPrior },
          })
        : undefined;

      const ge = Number((caps.GE1 + caps.GE2).toFixed(3));
      const visual = Number(((caps.VP + caps.VA + caps.CG) / 2).toFixed(3));
      const music = Number(((caps.MB + caps.MA + caps.MP) / 2).toFixed(3));
      rows.push({
        rank: 0,
        corps_key: entry.corps_key,
        historical_corps_key: corpsKey === entry.corps_key ? undefined : corpsKey,
        corps: entry.unit_name,
        city: entry.display_city,
        division,
        performance_order: entry.performance_order,
        time: entry.time,
        total: Number((ge + visual + music).toFixed(3)),
        GE: ge,
        Visual: visual,
        Music: music,
        ...caps,
        predicted_score_breakdown:
          predictedScoreBreakdown == null
            ? undefined
            : Object.fromEntries(
                CAPTIONS.map((caption) => {
                  const pair = predictedScoreBreakdown[caption];
                  return [
                    caption,
                    {
                      content: Number(pair.content.toFixed(3)),
                      achievement: Number(pair.achievement.toFixed(3)),
                      content_share: Number(pair.contentShare.toFixed(6)),
                      curve_share: Number(pair.curveShare.toFixed(6)),
                      prior_share:
                        pair.priorShare == null ? null : Number(pair.priorShare.toFixed(6)),
                      prior_weight: Number(pair.priorWeight.toFixed(6)),
                      prior_count: pair.priorCount,
                      split_source: pair.splitSource,
                    },
                  ];
                })
              ),
        caption_intervals: Object.fromEntries(
          CAPTIONS.map((caption) => {
            const offsets = rawIntervals[caption];
            return [
              caption,
              {
                p10: Number(
                  Math.max(0, Math.min(20, caps[caption] + offsets.low_offset)).toFixed(3)
                ),
                p50: Number(caps[caption].toFixed(3)),
                p90: Number(
                  Math.max(0, Math.min(20, caps[caption] + offsets.high_offset)).toFixed(3)
                ),
              },
            ];
          })
        ),
        raw_model_total: useBaseline ? Number(totalFromV9Captions(rawCaps).toFixed(3)) : undefined,
        model_blend_weight: modelWeight,
        caption_shape_model_weight: Number(shapeModelWeight.toFixed(3)),
        interval_scale: Number(intervalScale.toFixed(3)),
        observed_history_len: historyLen,
        prior_season_comparable_total: priorSeasonComparable?.total,
        prior_season_comparable_percent_through: priorSeasonComparable?.percentThrough,
        prior_season_comparable_competition: priorSeasonComparable?.competitionSlug,
        prior_season_comparable_weight: Number(comparableWeight.toFixed(3)),
        preseason_target_total:
          preseasonTargetTotal == null ? undefined : Number(preseasonTargetTotal.toFixed(3)),
        caption_shape_total: Number(pointCapsTotal.toFixed(3)),
        total_reconciliation_delta:
          preseasonTargetTotal == null
            ? undefined
            : Number((finalTotal - pointCapsTotal).toFixed(3)),
        mode,
        template_source: features.provenance.template.source,
        seed_rank: seedRank,
        prior_season_rank: priorSeasonRank,
        baseline_rank_source: features.baseline.rankSource,
        baseline_confidence: features.baseline.confidence,
        feature_static_dim: features.staticFeatures.length,
        model_static_dim: modelStaticDim,
        fingerprint_confidence: features.staticFeatures.at(-1),
        baseline_total: Number(baselineTotal.toFixed(3)),
        point_estimate_source: useBaseline
          ? priorSeasonComparable
            ? 'caption_shape_preserving_baseline_blended_with_prior_season_comparable_total'
            : 'caption_shape_preserving_baseline'
          : modelWeight < 1
            ? 'history_baseline_model_residual_blend'
            : 'model_q50',
      });
    }

    model.dispose();
    rows.sort((a: any, b: any) => (b.total ?? -Infinity) - (a.total ?? -Infinity));
    rows.forEach((row: any, idx) => {
      if (typeof row.total === 'number') row.rank = idx + 1;
    });

    const outputPath =
      cli.output ??
      path.join('results', 'predictions', `${event.slug}-prediction-${nowStamp()}.json`);
    const output = {
      generated_at: new Date().toISOString(),
      model_dir: modelDir,
      event,
      competition,
      readiness: {
        lineup_rows: lineup.length,
        matched_corps_keys: lineup.filter((row) => row.corps_key).length,
        lineup_source: lineupSource,
        scored_prediction_rows: rows.length,
        skipped_lineup_rows: skippedRows.length,
        judge_assignments: judgeInfo.known,
        mode,
        percent_through: percentThrough,
      },
      input_signature: inputSignature,
      builder_version: builderVersion,
      model_metadata: {
        model_static_dim: modelStaticDim,
        feature_static_dim: V9_RAW_STATIC_DIM,
        model_fingerprint: modelFingerprint,
        supports_caption_fingerprints: supportsCaptionFingerprints,
        interval_scale: intervalScale,
        breakdown_split_curves: breakdownSplitCurves
          ? {
              path: cli.breakdownSplitCurves,
              version: breakdownSplitCurves.version,
              generated_at: breakdownSplitCurves.generatedAt,
              global_content_share: breakdownSplitCurves.global.contentShare,
              evaluation: breakdownSplitCurves.evaluation,
              same_season_prior_enabled: cli.sameSeasonBreakdownPrior,
            }
          : undefined,
      },
      input_audit: {
        scored_lineup_rows: lineup.length,
        lineup_source: lineupSource,
        lineup: sortedLineup.map((row) => ({
          corps_key: row.corps_key,
          corps: row.unit_name,
          division: row.division_name,
          performance_order: row.performance_order,
          time: row.time,
        })),
        skipped_lineup_rows: skippedRows,
        exclusions: lineupAudit.exclusions,
        readiness: lineupAudit.readiness,
      },
      predictions: rows,
      caveats: [
        lineupSource !== 'event_lineup'
          ? 'Event lineup was missing; prediction used the prior-season championship field as an estimated lineup.'
          : null,
        skippedRows.length
          ? `${skippedRows.length} lineup row(s) were skipped because their division is not supported by this V9 model.`
          : null,
        judgeInfo.known < CAPTIONS.length
          ? 'Judge panel is incomplete or unknown; judge effects were masked.'
          : null,
        mode === 'preseason_forecast'
          ? 'No same-season history was available before this event; forecast uses preseason-style masking.'
          : null,
        mode === 'preseason_forecast'
          ? rows.some((row: any) => isAllAgeDivision(row.division))
            ? 'All Age forecasts use prior-season All Age caption scores as a baseline because the V9 model was not trained on All Age sequence rows.'
            : 'Prior-season comparable scores are blended with preseason baselines, not copied as exact targets.'
          : null,
        !supportsCaptionFingerprints
          ? 'Loaded model uses an older static feature shape; caption-fingerprint static features were not consumed by the neural model.'
          : null,
        rows.some((row: any) => row.template_source === 'synthetic_unknown_corps')
          ? 'At least one corps used synthetic unknown-corps features because no historical template row was found.'
          : null,
      ].filter(Boolean),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    if (cli.saveDb) {
      const predictionId = await saveEventPredictionRun(db, output);
      console.log(`Stored prediction run in SQLite: ${predictionId}`);
    }
    console.table(
      rows.map((row: any) => ({
        rank: row.rank,
        corps: row.corps,
        division: row.division,
        total: row.total,
        GE: row.GE,
        Visual: row.Visual,
        Music: row.Music,
        template: row.template_source,
      }))
    );
    console.log(`\nWrote ${outputPath}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
