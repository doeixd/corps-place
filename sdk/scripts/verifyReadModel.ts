// Parity harness (READ_MODEL_PLAN §11): the key safety net for "no behavior
// change". For a representative set of slugs (and the full directory), it runs
// the shared builder against the big dci-relational.db and compares it to the
// frozen rm_* rows in read-model.db, asserting deep equality. Run in CI on every
// emit so the live query and the read-model can't silently diverge.
//
// Usage:
//   npx tsx scripts/verifyReadModel.ts
//   npx tsx scripts/verifyReadModel.ts --source <db> --model <db> --sample 25

import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildAllEvents,
  buildCorpsBySlug,
  buildCorpsDirectory,
  buildCorpsSeasonScores,
  buildCorpsSeasonSnapshots,
  buildEventRecap,
  buildEventPreviousRecap,
  buildPredictedEventSlugs,
  buildLatestPredictionSummary,
  buildEventPredictionSnapshotDates,
  buildEventPredictionAsOf,
  buildEventSchedule,
  buildEventsForSeason,
  buildHomeWeekendShows,
  buildLatestResults,
  buildSeasonStandings,
  buildFeaturedPrediction,
  buildJudgeDirectory,
  buildJudgeProfile,
  buildShowInfoForSeason,
  buildShowTitlesForSeason,
  type EventDirectoryRow,
} from '../src/readModel/builders/index.js';
import {
  readAllEvents,
  readCorpsBySlug,
  readCorpsDirectory,
  readCorpsSeasonScores,
  readCorpsSeasonSnapshots,
  readEventRecap,
  readEventPreviousRecap,
  readEventPredictionSnapshotDates,
  readEventPredictionAsOf,
  readEventSchedule,
  readEventsForSeason,
  readHomeWeekendShows,
  readLatestResults,
  readSeasonStandings,
  readFeaturedPrediction,
  readJudgeDirectory,
  readJudgeProfile,
  readShowInfoForSeason,
  readShowTitlesForSeason,
} from '../src/readModel/readers.js';

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const sdkRoot = path.resolve(process.cwd());
const SOURCE = arg('--source', path.resolve(sdkRoot, 'dci-relational.db'));
// Default to the currently-active A/B slot (what the emit just published), so a
// post-emit CI check verifies the live build. Falls back to the legacy single
// file when no pointer exists. Mirrors app/lib/read-model-db.ts.
const resolveModel = (base: string): string => {
  const dir = path.dirname(base);
  const stem = path.basename(base).replace(/\.db$/i, '');
  try {
    const slot = fs.readFileSync(path.join(dir, `${stem}.active`), 'utf8').trim();
    if (slot === 'a' || slot === 'b') {
      const f = path.join(dir, `${stem}.${slot}.db`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no pointer — legacy single file */
  }
  return base;
};
const MODEL = arg('--model', resolveModel(path.resolve(sdkRoot, 'read-model.db')));
const SAMPLE = Number(arg('--sample', '20'));

let failures = 0;
let checks = 0;

// Canonicalize for comparison: recursively sort object keys (the builder's row
// objects use SELECT-column order; rm_* rows use schema order) and drop
// null/undefined-valued keys so "missing key" == null == undefined. This makes
// the check value-equality, not serialization-equality.
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === null || val === undefined) continue;
      out[k] = canon(val);
    }
    return out;
  }
  return v;
};
const norm = (v: unknown) => canon(v);
const eq = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const check = (label: string, expected: unknown, actual: unknown) => {
  checks++;
  if (!eq(expected, actual)) {
    failures++;
    console.error(`✗ ${label}`);
    const e = JSON.stringify(norm(expected));
    const a = JSON.stringify(norm(actual));
    console.error(`    builder:    ${e.slice(0, 300)}`);
    console.error(`    read-model: ${a.slice(0, 300)}`);
  }
};

// Map a rm_events row back to the EventDirectoryRow shape the builder produces.
// venue_name/venue_address are intentionally omitted: buildAllEvents doesn't
// compute them (the all-seasons directory has no venue column), so rm_events is
// enriched with current-season venues from buildEventsForSeason — verified
// separately below, not against buildAllEvents.
const rmEventToRow = (r: any): EventDirectoryRow => ({
  event_id: r.event_id,
  season: r.season,
  slug: r.slug,
  name: r.name,
  event_name: r.event_name,
  start_date: r.start_date,
  start_time: r.start_time,
  web_start_time: r.web_start_time,
  edt_start_time: r.edt_start_time,
  timezone: r.timezone,
  location_city: r.location_city,
  location_state: r.location_state,
  event_image: r.event_image,
  event_image_thumb: r.event_image_thumb,
  competition_slug: r.competition_slug,
  scores_released: r.scores_released,
  recap_released: r.recap_released,
  lineup_entries: r.lineup_entries,
  all_times_present: r.all_times_present,
  participant_entries: r.participant_entries,
  schedule_entries: r.schedule_entries,
  judge_assignments: r.judge_assignments,
  prediction_runs: r.prediction_runs,
  latest_prediction_at: r.latest_prediction_at,
});

const sampleOf = <T>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr;
  const step = Math.floor(arr.length / n);
  return Array.from({ length: n }, (_, i) => arr[i * step]);
};

const main = async () => {
  if (!fs.existsSync(MODEL)) {
    console.error(`read-model not found: ${MODEL}. Run emitReadModel.ts first.`);
    process.exit(1);
  }
  const src = createClient({ url: `file:${SOURCE}` });
  const rm = createClient({ url: `file:${MODEL}` });

  // ── Events: full directory parity ─────────────────────────────────────────
  console.log('verifying events directory…');
  const builderEvents = await buildAllEvents(src);
  const rmEventRows = (await rm.execute('SELECT * FROM rm_events')).rows as any[];
  const rmByEventId = new Map(rmEventRows.map((r) => [r.event_id, r]));
  check('rm_events row count', builderEvents.length, rmEventRows.length);
  for (const e of builderEvents) {
    const rmRow = rmByEventId.get(e.event_id ?? e.slug);
    check(`event ${e.event_id ?? e.slug}`, e, rmRow ? rmEventToRow(rmRow) : null);
  }

  // ── 2026 venue enrichment: rm_events venues must match the season builder ──
  console.log('verifying 2026 venue enrichment…');
  const seasonEvents = await buildEventsForSeason(src, '2026');
  for (const se of seasonEvents) {
    const rmRow = rmEventRows.find((r) => r.slug === se.slug && r.season === '2026');
    check(`venue ${se.slug}`, { venue_name: se.venue_name, venue_address: se.venue_address },
      rmRow ? { venue_name: rmRow.venue_name, venue_address: rmRow.venue_address } : null);
  }

  // ── Event schedule: sampled slugs ──────────────────────────────────────────
  console.log('verifying event schedules (sampled)…');
  const eventSlugsWithLineups = builderEvents.filter((e) => e.lineup_entries > 0);
  for (const e of sampleOf(eventSlugsWithLineups, SAMPLE)) {
    const builderSched = await buildEventSchedule(src, e.slug);
    const rmSched = (
      await rm.execute({
        sql: `SELECT performance_order, unit_name, time, is_non_performance, is_exhibition,
                     division_name, corps_key FROM rm_event_schedule WHERE event_slug = ? ORDER BY sort_index`,
        args: [e.slug],
      })
    ).rows;
    check(`schedule ${e.slug}`, builderSched, rmSched);
  }

  // ── Corps directory ────────────────────────────────────────────────────────
  console.log('verifying corps directory…');
  const builderCorps = await buildCorpsDirectory(src);
  const rmCorps = (await rm.execute('SELECT * FROM rm_corps ORDER BY sort_index')).rows as any[];
  check('rm_corps row count', builderCorps.length, rmCorps.length);
  builderCorps.forEach((c, i) => {
    const r = rmCorps[i];
    check(`corps ${c.corps_key}`, c, r ? {
      corps_key: r.corps_key, slug: r.slug, name: r.name, division_name: r.division_name,
      display_city: r.display_city, corps_logo: r.corps_logo, active: r.active,
      performing: r.performing, is_alumni: r.is_alumni, aliases: JSON.parse(r.aliases_json),
    } : null);
  });

  // ── Corps season scores: sampled ────────────────────────────────────────────
  console.log('verifying corps season scores (sampled)…');
  for (const c of sampleOf(builderCorps.filter((c) => c.slug), SAMPLE)) {
    const slug = c.slug as string;
    const builderPts = await buildCorpsSeasonScores(src, slug);
    const rmPts = (
      await rm.execute({
        sql: `SELECT date, label, slug, predicted, actual, low, high
              FROM rm_corps_season_points WHERE corps_slug = ? ORDER BY sort_index`,
        args: [slug],
      })
    ).rows;
    check(`season-scores ${slug}`, builderPts, rmPts);
  }

  // ── Recaps: sampled ──────────────────────────────────────────────────────────
  console.log('verifying recaps (sampled)…');
  for (const e of sampleOf(builderEvents.filter((e) => e.scores_released), SAMPLE)) {
    const builderRecap = await buildEventRecap(src, e.slug);
    if (!builderRecap.meta) continue;
    const rmRow = (
      await rm.execute({
        sql: `SELECT meta_json, scores_json FROM rm_event_recap WHERE competition_slug = ?`,
        args: [builderRecap.meta.slug],
      })
    ).rows[0] as any;
    check(`recap ${e.slug} meta`, builderRecap.meta, rmRow ? JSON.parse(rmRow.meta_json) : null);
    check(`recap ${e.slug} scores`, builderRecap.scores, rmRow ? JSON.parse(rmRow.scores_json) : null);
    // Previous-show recap parity (Diff "vs Previous" basis). Only assert when the
    // builder finds prior shows — season openers legitimately emit no row.
    const builderPrev = await buildEventPreviousRecap(src, builderRecap.meta.slug);
    if (builderPrev.rows.length > 0) {
      const prevRow = (
        await rm.execute({
          sql: `SELECT rows_json, sources_json FROM rm_event_previous_recap WHERE competition_slug = ?`,
          args: [builderRecap.meta.slug],
        })
      ).rows[0] as any;
      check(`previous-recap ${e.slug} rows`, builderPrev.rows,
        prevRow ? JSON.parse(prevRow.rows_json) : null);
      check(`previous-recap ${e.slug} sources`, builderPrev.sources,
        prevRow ? JSON.parse(prevRow.sources_json) : null);
    }
  }

  // ── Judges directory ──────────────────────────────────────────────────────────
  console.log('verifying judges directory…');
  const builderJudges = await buildJudgeDirectory(src);
  const rmJudges = (await rm.execute('SELECT summary_json FROM rm_judges')).rows as any[];
  check('rm_judges row count', builderJudges.length, rmJudges.length);

  // ── Readers vs builders (Phase 3): the actual service code path ────────────
  // The services call these readers when READ_MODEL_DB_URL is set; assert they
  // return exactly what the builders (big-DB fallback) return.
  console.log('verifying readers == builders (service fast path)…');
  check('readEventsForSeason 2026', await buildEventsForSeason(src, '2026'),
    await readEventsForSeason(rm, '2026'));
  check('readAllEvents (full)', await buildAllEvents(src), await readAllEvents(rm));
  for (const c of sampleOf(builderCorps.filter((c) => c.slug), SAMPLE)) {
    const slug = c.slug as string;
    check(`readCorpsBySlug ${slug}`, await buildCorpsBySlug(src, slug), await readCorpsBySlug(rm, slug));
    check(`readCorpsSeasonScores ${slug}`, await buildCorpsSeasonScores(src, slug),
      await readCorpsSeasonScores(rm, slug));
    check(`readCorpsSeasonSnapshots ${slug}`, await buildCorpsSeasonSnapshots(src, slug),
      await readCorpsSeasonSnapshots(rm, slug));
  }
  check('readCorpsDirectory', await buildCorpsDirectory(src), await readCorpsDirectory(rm));
  check('readJudgeDirectory', await buildJudgeDirectory(src), await readJudgeDirectory(rm));
  check('readShowTitlesForSeason 2026', await buildShowTitlesForSeason(src, '2026'),
    await readShowTitlesForSeason(rm, '2026'));
  check('readShowInfoForSeason 2026', await buildShowInfoForSeason(src, '2026'),
    await readShowInfoForSeason(rm, '2026'));
  check('readHomeWeekendShows 2026', await buildHomeWeekendShows(src, '2026'),
    await readHomeWeekendShows(rm, '2026'));
  check('readLatestResults', await buildLatestResults(src), await readLatestResults(rm));
  check('readSeasonStandings', await buildSeasonStandings(src), await readSeasonStandings(rm));
  const fpNow = new Date('2026-06-12T12:00:00Z');
  check('readFeaturedPrediction', await buildFeaturedPrediction(src, fpNow),
    await readFeaturedPrediction(rm, fpNow));
  for (const j of sampleOf(builderJudges, SAMPLE)) {
    check(`readJudgeProfile ${j.judge_id}`, await buildJudgeProfile(src, j.judge_id),
      await readJudgeProfile(rm, j.judge_id));
  }
  for (const e of sampleOf(eventSlugsWithLineups, SAMPLE)) {
    check(`readEventSchedule ${e.slug}`, await buildEventSchedule(src, e.slug),
      await readEventSchedule(rm, e.slug));
  }
  for (const e of sampleOf(builderEvents.filter((e) => e.scores_released), SAMPLE)) {
    check(`readEventRecap ${e.slug}`, await buildEventRecap(src, e.slug), await readEventRecap(rm, e.slug));
    check(`readEventPreviousRecap ${e.slug}`,
      await buildEventPreviousRecap(src, e.slug), await readEventPreviousRecap(rm, e.slug));
  }
  // Forecast-as-of: reader==builder for dates + a sampled as-of; and the invariant
  // that the newest snapshot's recap equals the latest saved prediction's recap.
  const predictedSlugs = await buildPredictedEventSlugs(src, '2026');
  for (const slug of sampleOf(predictedSlugs, SAMPLE)) {
    const dates = await buildEventPredictionSnapshotDates(src, slug, '2026');
    check(`readEventPredictionSnapshotDates ${slug}`, dates,
      await readEventPredictionSnapshotDates(rm, slug));
    if (dates.length === 0) continue;
    check(`readEventPredictionAsOf ${slug} @ ${dates[0]}`,
      await buildEventPredictionAsOf(src, slug, dates[0], '2026'),
      await readEventPredictionAsOf(rm, slug, dates[0]));
    // Newest snapshot recap == the latest prediction summary recap (parity).
    const newest = await buildEventPredictionAsOf(src, slug, dates[0], '2026');
    const latest = await buildLatestPredictionSummary(src, slug, '2026');
    if (newest && latest)
      check(`prediction-snapshot newest==latest ${slug}`, newest.recap, latest.summary.recap);
  }

  src.close();
  rm.close();

  console.log('─────────────────────────────────────────');
  console.log(`${checks} checks, ${failures} failures`);
  if (failures > 0) {
    console.error('PARITY FAILED — read-model diverges from builders.');
    process.exit(1);
  }
  console.log('PARITY OK — read-model matches builders.');
};

main().catch((err) => {
  console.error('verifyReadModel FAILED:', err);
  process.exit(1);
});
