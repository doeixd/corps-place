import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V9_RAW_STATIC_DIM } from '../src/training/v9FeatureModes.js';
import {
  aggregateV9BreakdownSubcaptions,
  extractV9BreakdownPriorFeatures,
  totalFromV9BreakdownCaptions,
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownSubcaptionRow,
} from '../src/training/v9BreakdownData.js';

const EXPECTED_SEQUENCE_STEPS = 15;
const EXPECTED_SEQUENCE_DIM = 101;
const EXPECTED_STATIC_DIM = V9_RAW_STATIC_DIM;
const EXPECTED_JUDGE_DIM = 8;

type MlRow = {
  season: string;
  competition_slug: string;
  competition_date: string;
  division_name: string;
  corps_key: string;
  corps_id: number;
  x_sequence_json: string;
  x_static_json: string;
  judge_indices_json: string;
  y_recap_json: string;
  y_total: number;
  agnostic_show_id: number;
  split: string;
};

type CaptionCoverage = {
  validPairs: number;
  missingPairs: number;
  scaleRepairs: number;
  scaleExclusions: number;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  return {
    dbPath: get('--db', 'dci-relational.db')!,
    output: get('--output', 'results/v9-breakdown-coverage-audit.json')!,
  };
};

const increment = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

const mergeUnknownLabels = (target: Record<string, number>, source: Map<string, number>) => {
  for (const [key, count] of source) increment(target, key, count);
};

const loadSubcaptionRows = async (client: ReturnType<typeof createClient>) => {
  const result = await client.execute(`
    SELECT competition_slug, corps_key, caption_name, judge_id, subcaption_name, score
    FROM subcaption_scores
  `);

  const grouped = new Map<string, V9BreakdownSubcaptionRow[]>();
  for (const row of result.rows) {
    const entry = {
      competition_slug: String(row.competition_slug),
      corps_key: String(row.corps_key),
      caption_name: String(row.caption_name),
      judge_id: row.judge_id == null ? null : String(row.judge_id),
      subcaption_name: String(row.subcaption_name),
      score: Number(row.score),
    };
    const key = `${entry.competition_slug}|${entry.corps_key}`;
    const rows = grouped.get(key) ?? [];
    rows.push(entry);
    grouped.set(key, rows);
  }
  return grouped;
};

const main = async () => {
  const args = parseArgs();
  const client = createClient({ url: `file:${args.dbPath}` });

  const mlResult = await client.execute(`
    SELECT season, competition_slug, competition_date, division_name, corps_key, corps_id,
           x_sequence_json, x_static_json, judge_indices_json, y_recap_json, y_total,
           agnostic_show_id, split
    FROM ml_sequence_rows_v9_subcaption
  `);
  const rows = mlResult.rows as unknown as MlRow[];
  const subcaptionByKey = await loadSubcaptionRows(client);

  const byCaption = Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption) => [
      caption,
      { validPairs: 0, missingPairs: 0, scaleRepairs: 0, scaleExclusions: 0 },
    ])
  ) as Record<(typeof V9_BREAKDOWN_CAPTIONS)[number], CaptionCoverage>;
  const byDivision: Record<string, number> = {};
  const bySeason: Record<string, number> = {};
  const bySplit: Record<string, number> = {};
  const unknownLabels: Record<string, number> = {};

  let rowsWithAnyPair = 0;
  let rowsWithAllPairs = 0;
  let rowsWithNoPairs = 0;
  let badSequenceDimensions = 0;
  let badStaticDimensions = 0;
  let badPriorFeatureShape = 0;
  let badJudgeDimensions = 0;
  let badCaptionTargets = 0;
  let badTotalConsistency = 0;
  let jsonErrors = 0;
  let totalScaleRepairs = 0;
  let totalScaleExclusions = 0;

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
        badSequenceDimensions += 1;
      }
      if (!Array.isArray(stat) || stat.length !== EXPECTED_STATIC_DIM) badStaticDimensions += 1;
      if (!extractV9BreakdownPriorFeatures(stat).hasExpectedStaticShape) badPriorFeatureShape += 1;
      if (!Array.isArray(judges) || judges.length !== EXPECTED_JUDGE_DIM) badJudgeDimensions += 1;
      if (
        V9_BREAKDOWN_CAPTIONS.some(
          (caption) => !Number.isFinite(recap[caption]) || recap[caption] <= 0 || recap[caption] > 20
        )
      ) {
        badCaptionTargets += 1;
      }
      if (Math.abs(totalFromV9BreakdownCaptions(recap) - Number(row.y_total)) > 0.05) {
        badTotalConsistency += 1;
      }

      const subRows = subcaptionByKey.get(`${row.competition_slug}|${row.corps_key}`) ?? [];
      const aggregate = aggregateV9BreakdownSubcaptions(subRows, recap);
      mergeUnknownLabels(unknownLabels, aggregate.unknownLabels);
      totalScaleRepairs += aggregate.scaleRepairs;
      totalScaleExclusions += aggregate.scaleExclusions;

      const validPairCount = V9_BREAKDOWN_CAPTIONS.filter(
        (caption) => aggregate.mask[caption].pair
      ).length;
      if (validPairCount === 0) rowsWithNoPairs += 1;
      if (validPairCount > 0) {
        rowsWithAnyPair += 1;
        increment(byDivision, String(row.division_name));
        increment(bySeason, String(row.season));
        increment(bySplit, String(row.split));
      }
      if (validPairCount === V9_BREAKDOWN_CAPTIONS.length) rowsWithAllPairs += 1;

      for (const caption of V9_BREAKDOWN_CAPTIONS) {
        if (aggregate.mask[caption].pair) byCaption[caption].validPairs += 1;
        else byCaption[caption].missingPairs += 1;
      }
    } catch {
      jsonErrors += 1;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    db_path: args.dbPath,
    ml_table: 'ml_sequence_rows_v9_subcaption',
    source_table: 'subcaption_scores',
    totals: {
      ml_rows: rows.length,
      rows_with_any_valid_pair: rowsWithAnyPair,
      rows_with_all_8_pairs: rowsWithAllPairs,
      rows_with_no_valid_pairs: rowsWithNoPairs,
      total_scale_repairs: totalScaleRepairs,
      total_scale_exclusions: totalScaleExclusions,
    },
    dimensions: {
      expected_sequence_steps: EXPECTED_SEQUENCE_STEPS,
      expected_sequence_dim: EXPECTED_SEQUENCE_DIM,
      expected_static_dim: EXPECTED_STATIC_DIM,
      expected_judge_dim: EXPECTED_JUDGE_DIM,
      bad_sequence_dimensions: badSequenceDimensions,
      bad_static_dimensions: badStaticDimensions,
      bad_prior_feature_shape: badPriorFeatureShape,
      bad_judge_dimensions: badJudgeDimensions,
    },
    target_quality: {
      json_errors: jsonErrors,
      bad_caption_targets: badCaptionTargets,
      bad_total_consistency: badTotalConsistency,
    },
    by_caption: byCaption,
    rows_with_valid_pairs_by_division: byDivision,
    rows_with_valid_pairs_by_season: bySeason,
    rows_with_valid_pairs_by_split: bySplit,
    unknown_labels: Object.fromEntries(
      Object.entries(unknownLabels)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
    ),
    hard_failures:
      rows.length === 0 ||
      jsonErrors > 0 ||
      badSequenceDimensions > 0 ||
      badStaticDimensions > 0 ||
      badPriorFeatureShape > 0 ||
      badJudgeDimensions > 0 ||
      badCaptionTargets > 0 ||
      rowsWithAnyPair === 0,
  };

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`V9 breakdown coverage audit written to ${args.output}`);
  console.log(
    `Rows with any pair: ${rowsWithAnyPair}/${rows.length}; all 8 pairs: ${rowsWithAllPairs}; no pairs: ${rowsWithNoPairs}`
  );
  if (report.hard_failures) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
