import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V9_FEATURE_INDICES, V9_RAW_STATIC_DIM } from '../src/training/v9FeatureModes.js';

const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
const EXPECTED_SEQUENCE_STEPS = 15;
const EXPECTED_SEQUENCE_DIM = 101;
const EXPECTED_STATIC_DIM = V9_RAW_STATIC_DIM;
const EXPECTED_JUDGE_DIM = 8;
const DIVISIONS = ['World Class', 'Open Class'] as const;

type AuditResult = {
  name: string;
  value: number | string;
  ok: boolean;
};

const dbPath = process.argv[2] ?? 'dci-relational.db';
const client = createClient({ url: `file:${dbPath}` });

const readJson = <T>(relativePath: string): T => {
  const fullPath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
};

const totalFromCaptions = (recap: Record<string, number>) =>
  (recap.GE1 ?? 0) +
  (recap.GE2 ?? 0) +
  ((recap.VP ?? 0) + (recap.VA ?? 0) + (recap.CG ?? 0)) / 2 +
  ((recap.MB ?? 0) + (recap.MA ?? 0) + (recap.MP ?? 0)) / 2;

const scalar = async (sql: string) => {
  const result = await client.execute(sql);
  return Number(Object.values(result.rows[0] ?? { count: 0 })[0] ?? 0);
};

const hasColumn = async (table: string, column: string) => {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => row.name === column);
};

const main = async () => {
  const results: AuditResult[] = [];
  const rowsResult = await client.execute(`
    SELECT
      season,
      competition_slug,
      competition_date,
      division_name,
      corps_key,
      corps_id,
      x_sequence_json,
      x_static_json,
      judge_indices_json,
      y_recap_json,
      y_total,
      agnostic_show_id,
      split
    FROM ml_sequence_rows_v9_subcaption
  `);

  const rows = rowsResult.rows;
  results.push({ name: 'row_count', value: rows.length, ok: rows.length > 0 });

  let badSequenceDim = 0;
  let badStaticDim = 0;
  let badJudgeDim = 0;
  let badJudgeIndex = 0;
  let badCaptionTarget = 0;
  let badTotalConsistency = 0;
  let missingCorpsId = 0;
  let missingShowId = 0;
  let badCaptionFingerprint = 0;
  let rowsWithCaptionFingerprint = 0;
  let jsonErrors = 0;

  const splitByShow = new Map<string, Set<string>>();
  for (const row of rows) {
    try {
      const sequence = JSON.parse(String(row.x_sequence_json)) as number[][];
      const stat = JSON.parse(String(row.x_static_json)) as number[];
      const judges = JSON.parse(String(row.judge_indices_json)) as number[];
      const recap = JSON.parse(String(row.y_recap_json)) as Record<string, number>;

      if (
        sequence.length !== EXPECTED_SEQUENCE_STEPS ||
        sequence.some((step) => !Array.isArray(step) || step.length !== EXPECTED_SEQUENCE_DIM)
      ) {
        badSequenceDim += 1;
      }
      if (!Array.isArray(stat) || stat.length !== EXPECTED_STATIC_DIM) badStaticDim += 1;
      if (!Array.isArray(judges) || judges.length !== EXPECTED_JUDGE_DIM) badJudgeDim += 1;
      if (!Array.isArray(judges) || judges.some((idx) => !Number.isFinite(idx) || idx <= 0))
        badJudgeIndex += 1;
      if (
        CAPTIONS.some(
          (caption) =>
            !Number.isFinite(recap[caption]) || recap[caption] <= 0 || recap[caption] > 20
        )
      ) {
        badCaptionTarget += 1;
      }
      if (Math.abs(totalFromCaptions(recap) - Number(row.y_total)) > 0.05) badTotalConsistency += 1;
      if (!Number.isFinite(Number(row.corps_id)) || Number(row.corps_id) <= 0) missingCorpsId += 1;
      if (!Number.isFinite(Number(row.agnostic_show_id)) || Number(row.agnostic_show_id) <= 0)
        missingShowId += 1;
      const fingerprint = stat.slice(
        V9_FEATURE_INDICES.captionFingerprintStart,
        V9_FEATURE_INDICES.captionFingerprintEnd + 1
      );
      const confidence = stat[V9_FEATURE_INDICES.captionFingerprintConfidence] ?? 0;
      if (
        fingerprint.length !==
          V9_FEATURE_INDICES.captionFingerprintEnd -
            V9_FEATURE_INDICES.captionFingerprintStart +
            1 ||
        fingerprint.some((value) => !Number.isFinite(value) || Math.abs(value) > 4) ||
        confidence < 0 ||
        confidence > 1
      ) {
        badCaptionFingerprint += 1;
      }
      if (fingerprint.some((value) => Math.abs(value) > 1e-6)) rowsWithCaptionFingerprint += 1;

      const showKey = `${row.season}|${row.competition_slug}|${row.competition_date}`;
      const splitSet = splitByShow.get(showKey) ?? new Set<string>();
      splitSet.add(String(row.split));
      splitByShow.set(showKey, splitSet);
    } catch {
      jsonErrors += 1;
    }
  }

  const mixedSplitShows = [...splitByShow.values()].filter((splits) => splits.size > 1).length;
  results.push({ name: 'json_errors', value: jsonErrors, ok: jsonErrors === 0 });
  results.push({
    name: 'bad_sequence_dimensions',
    value: badSequenceDim,
    ok: badSequenceDim === 0,
  });
  results.push({ name: 'bad_static_dimensions', value: badStaticDim, ok: badStaticDim === 0 });
  results.push({ name: 'bad_judge_dimensions', value: badJudgeDim, ok: badJudgeDim === 0 });
  results.push({ name: 'bad_judge_indices', value: badJudgeIndex, ok: badJudgeIndex === 0 });
  results.push({
    name: 'bad_caption_targets',
    value: badCaptionTarget,
    ok: badCaptionTarget === 0,
  });
  results.push({
    name: 'bad_total_consistency',
    value: badTotalConsistency,
    ok: badTotalConsistency === 0,
  });
  results.push({ name: 'missing_corps_ids', value: missingCorpsId, ok: missingCorpsId === 0 });
  results.push({ name: 'missing_show_ids', value: missingShowId, ok: missingShowId === 0 });
  results.push({
    name: 'bad_caption_fingerprints',
    value: badCaptionFingerprint,
    ok: badCaptionFingerprint === 0,
  });
  results.push({
    name: 'rows_with_caption_fingerprints',
    value: rowsWithCaptionFingerprint,
    ok: rowsWithCaptionFingerprint > 0,
  });
  results.push({ name: 'mixed_split_shows', value: mixedSplitShows, ok: mixedSplitShows === 0 });

  results.push({
    name: 'duplicate_ml_keys',
    value: await scalar(`
      SELECT COUNT(*) FROM (
        SELECT season, competition_slug, division_name, corps_key
        FROM ml_sequence_rows_v9_subcaption
        GROUP BY season, competition_slug, division_name, corps_key
        HAVING COUNT(*) > 1
      )
    `),
    ok: true,
  });
  results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

  const hasProvenance =
    (await hasColumn('ml_sequence_rows_v9_subcaption', 'builder_version')) &&
    (await hasColumn('ml_sequence_rows_v9_subcaption', 'reference_curves_version')) &&
    (await hasColumn('ml_sequence_rows_v9_subcaption', 'map_version'));
  results.push({ name: 'has_provenance_columns', value: String(hasProvenance), ok: hasProvenance });

  if (hasProvenance) {
    results.push({
      name: 'missing_provenance_rows',
      value: await scalar(`
        SELECT COUNT(*)
        FROM ml_sequence_rows_v9_subcaption
        WHERE builder_version IS NULL OR reference_curves_version IS NULL OR map_version IS NULL
           OR builder_version = '' OR reference_curves_version = '' OR map_version = ''
      `),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;
  }

  results.push({
    name: 'raw_zero_targets_in_ml',
    value: await scalar(`
      SELECT COUNT(*)
      FROM ml_sequence_rows_v9_subcaption ml
      JOIN corps_scores cs
        ON cs.competition_slug = ml.competition_slug
       AND cs.corps_key = ml.corps_key
       AND cs.division_name = ml.division_name
      WHERE cs.total_score <= 0 OR cs.total_score > 100
    `),
    ok: true,
  });
  results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

  if (await hasColumn('judge_elo_ratings', 'division_name')) {
    results.push({
      name: 'judge_elo_unknown_ids',
      value: await scalar("SELECT COUNT(*) FROM judge_elo_ratings WHERE judge_id LIKE '%unknown%'"),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

    results.push({
      name: 'judge_elo_invalid_divisions',
      value: await scalar(
        "SELECT COUNT(*) FROM judge_elo_ratings WHERE division_name NOT IN ('World Class', 'Open Class')"
      ),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

    results.push({
      name: 'judge_elo_history_invalid_divisions',
      value: await scalar(
        "SELECT COUNT(*) FROM judge_elo_history WHERE division_name NOT IN ('World Class', 'Open Class')"
      ),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

    results.push({
      name: 'judge_elo_same_show_before_variants',
      value: await scalar(`
        SELECT COUNT(*) FROM (
          SELECT judge_id, season, division_name, competition_slug, caption_name
          FROM judge_elo_history
          GROUP BY judge_id, season, division_name, competition_slug, caption_name
          HAVING COUNT(DISTINCT ROUND(elo_before, 6)) > 1
        )
      `),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;
  } else {
    results.push({ name: 'judge_elo_division_column', value: 'missing', ok: false });
  }

  if (await hasColumn('corps_elo_ratings', 'division_name')) {
    results.push({
      name: 'corps_elo_invalid_divisions',
      value: await scalar(
        "SELECT COUNT(*) FROM corps_elo_ratings WHERE division_name NOT IN ('World Class', 'Open Class')"
      ),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

    results.push({
      name: 'corps_elo_history_invalid_divisions',
      value: await scalar(
        "SELECT COUNT(*) FROM corps_elo_history WHERE division_name NOT IN ('World Class', 'Open Class')"
      ),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;

    results.push({
      name: 'corps_elo_same_show_before_variants',
      value: await scalar(`
        SELECT COUNT(*) FROM (
          SELECT corps_key, season, division_name, competition_slug, caption_name
          FROM corps_elo_history
          GROUP BY corps_key, season, division_name, competition_slug, caption_name
          HAVING COUNT(DISTINCT ROUND(elo_before, 6)) > 1
        )
      `),
      ok: true,
    });
    results[results.length - 1]!.ok = results[results.length - 1]!.value === 0;
  } else {
    results.push({ name: 'corps_elo_division_column', value: 'missing', ok: false });
  }

  const referenceCurves = readJson<{ curves?: Record<string, Record<string, number>> }>(
    'src/training/referenceCurvesV4.json'
  );
  let badReferenceCells = 0;
  let referenceRankInversions = 0;
  let referenceProgressInversions = 0;
  for (const division of DIVISIONS) {
    for (let rank = 1; rank <= 25; rank++) {
      for (let bucket = 0; bucket <= 100; bucket += 5) {
        const curve = referenceCurves.curves?.[`${division}|${rank}-${bucket}`];
        if (!curve || CAPTIONS.some((caption) => !Number.isFinite(curve[caption]))) {
          badReferenceCells += 1;
        }
      }
    }

    for (let bucket = 0; bucket <= 100; bucket += 5) {
      for (const caption of CAPTIONS) {
        for (let rank = 1; rank < 25; rank++) {
          const better = referenceCurves.curves?.[`${division}|${rank}-${bucket}`]?.[caption];
          const worse = referenceCurves.curves?.[`${division}|${rank + 1}-${bucket}`]?.[caption];
          if (Number.isFinite(better) && Number.isFinite(worse) && better! < worse!) {
            referenceRankInversions += 1;
          }
        }
      }
    }

    for (let rank = 1; rank <= 25; rank++) {
      for (const caption of CAPTIONS) {
        for (let bucket = 0; bucket < 100; bucket += 5) {
          const earlier = referenceCurves.curves?.[`${division}|${rank}-${bucket}`]?.[caption];
          const later = referenceCurves.curves?.[`${division}|${rank}-${bucket + 5}`]?.[caption];
          if (Number.isFinite(earlier) && Number.isFinite(later) && earlier! > later!) {
            referenceProgressInversions += 1;
          }
        }
      }
    }
  }
  results.push({
    name: 'bad_reference_curve_cells',
    value: badReferenceCells,
    ok: badReferenceCells === 0,
  });
  results.push({
    name: 'reference_rank_inversions',
    value: referenceRankInversions,
    ok: referenceRankInversions === 0,
  });
  results.push({
    name: 'reference_progress_inversions',
    value: referenceProgressInversions,
    ok: referenceProgressInversions === 0,
  });

  const failed = results.filter((result) => !result.ok);
  console.table(results);
  await client.close();

  if (failed.length > 0) {
    console.error(
      `V9 subcaption data audit failed: ${failed.map((result) => result.name).join(', ')}`
    );
    process.exitCode = 1;
  } else {
    console.log('V9 subcaption data audit passed.');
  }
};

main().catch(async (error) => {
  console.error(error);
  await client.close();
  process.exitCode = 1;
});
