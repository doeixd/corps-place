import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V9_FEATURE_INDICES, V9_RAW_STATIC_DIM } from '../src/training/v9FeatureModes.js';
import { findLatestV9SubcaptionModelDir } from '../src/training/v9ModelPaths.js';
import {
  loadV9SubcaptionModel,
  type V9SubcaptionCheckpoint,
  type V9SubcaptionModel,
} from '../src/training/v9SubcaptionInference.js';
import {
  aggregateV9BreakdownSubcaptions,
  categoriesFromV9BreakdownCaptions,
  totalFromV9BreakdownCaptions,
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownSubcaptionRow,
} from '../src/training/v9BreakdownData.js';

const BUILDER_VERSION = 'v9-breakdown-builder-2026-06-04';
const EXPECTED_SEQUENCE_STEPS = 15;
const EXPECTED_SEQUENCE_DIM = 101;
const EXPECTED_STATIC_DIM = V9_RAW_STATIC_DIM;
const EXPECTED_JUDGE_DIM = 8;
const DEFAULT_SOURCE_MODEL_ID = 'anchor-synthetic-v9-breakdown-mvp';

type AnchorMode =
  | 'v9_predicted'
  | 'teacher_forcing'
  | 'synthetic_noisy'
  | 'baseline'
  | 'partial_synthetic_dropout'
  | 'full_dropout';

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

type BuildRow = {
  season: string;
  competition_slug: string;
  competition_date: string;
  division_name: string;
  corps_key: string;
  corps_id: number;
  x_sequence_json: string;
  x_static_json: string;
  judge_indices_json: string;
  agnostic_show_id: number;
  baseline_recap_json: string;
  v9_pred_recap_json: string;
  v9_pred_q10_json: string;
  v9_pred_q90_json: string;
  v9_pred_category_json: string;
  v9_pred_total: number;
  v9_interval_width_json: string;
  anchor_mode: AnchorMode;
  anchor_dropout_mask_json: string;
  anchor_noise_std: number;
  y_caption_json: string;
  y_subcaption_json: string;
  y_subcaption_mask_json: string;
  y_category_json: string;
  y_total: number;
  split: string;
  builder_version: string;
  source_v9_model_id: string;
  source_v9_model_path: string | null;
  source_v9_model_card_sha256: string | null;
  created_at: string;
};

type AnchorPayload = {
  anchor: Record<string, number>;
  q10: Record<string, number>;
  q90: Record<string, number>;
  width: Record<string, number>;
  categories: ReturnType<typeof categoriesFromV9BreakdownCaptions>;
  total: number;
  dropoutMask: Record<string, boolean>;
  noiseStd: number;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const has = (name: string) => args.includes(name);
  const get = (name: string, fallback?: string) => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  const requestedModelDir = get('--model-dir');
  const defaultModes = requestedModelDir
    ? 'v9_predicted,baseline,partial_synthetic_dropout'
    : 'teacher_forcing,synthetic_noisy,baseline,partial_synthetic_dropout';
  const modes = (get('--anchor-modes', defaultModes) ?? '')
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean) as AnchorMode[];

  return {
    dbPath: get('--db', 'dci-relational.db')!,
    output: get('--output', 'results/v9-breakdown-build-report.json')!,
    apply: has('--apply'),
    dryRun: has('--dry-run') || !has('--apply'),
    requestedModelDir,
    checkpoint: get('--checkpoint', 'auto')! as V9SubcaptionCheckpoint,
    sourceModelId: get('--source-model-id'),
    sourceModelPath: get('--source-model-path'),
    sourceModelCardSha256: get('--source-model-card-sha256'),
    noiseStd: Number(get('--noise-std', '0.35')),
    partialDropoutRate: Number(get('--partial-dropout-rate', '0.35')),
    maxRows: Number(get('--maxRows', '0')),
    modes,
  };
};

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};

const gaussianRandom = (rng: () => number) => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const clampCaptionScore = (value: number) => Number(Math.max(0, Math.min(20, value)).toFixed(4));

const vectorToCaptionRecord = (values: readonly number[]) =>
  Object.fromEntries(V9_BREAKDOWN_CAPTIONS.map((caption, idx) => [caption, values[idx] ?? 0])) as Record<
    string,
    number
  >;

const captionRecordToVector = (record: Record<string, number>) =>
  V9_BREAKDOWN_CAPTIONS.map((caption) => Number(record[caption] ?? 0));

const readBaselineFromStatic = (staticFeatures: readonly number[], fallback: Record<string, number>) => {
  const values = V9_BREAKDOWN_CAPTIONS.map((caption, idx) => {
    const normalized =
      staticFeatures[V9_FEATURE_INDICES.rankBaselineStart + idx] ?? (fallback[caption] ?? 15) / 20;
    const score = Number(normalized) * 20;
    return Number.isFinite(score) && score > 0 ? clampCaptionScore(score) : fallback[caption] ?? 15;
  });
  return vectorToCaptionRecord(values);
};

const makeAnchor = (
  mode: AnchorMode,
  recap: Record<string, number>,
  baseline: Record<string, number>,
  options: { noiseStd: number; partialDropoutRate: number; seed: number }
) => {
  if (mode === 'v9_predicted') {
    throw new Error('v9_predicted anchors require --model-dir and are generated by makeV9ModelAnchor.');
  }

  const rng = seededRandom(options.seed);
  const dropoutMask: Record<string, boolean> = {};
  const anchorValues: number[] = [];

  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    const actual = recap[caption] ?? baseline[caption] ?? 15;
    const base = baseline[caption] ?? actual;
    let value = actual;
    let dropped = false;

    if (mode === 'baseline' || mode === 'full_dropout') {
      value = base;
      dropped = true;
    } else if (mode === 'synthetic_noisy') {
      value = actual + gaussianRandom(rng) * options.noiseStd;
    } else if (mode === 'partial_synthetic_dropout') {
      dropped = rng() < options.partialDropoutRate;
      value = dropped ? base : actual + gaussianRandom(rng) * options.noiseStd;
    }

    dropoutMask[caption] = dropped;
    anchorValues.push(clampCaptionScore(value));
  }

  const anchor = vectorToCaptionRecord(anchorValues);
  const width = V9_BREAKDOWN_CAPTIONS.map(() => {
    if (mode === 'teacher_forcing') return 0.5;
    if (mode === 'baseline' || mode === 'full_dropout') return 2.5;
    return Math.max(0.5, options.noiseStd * 3.2);
  });
  const q10 = vectorToCaptionRecord(anchorValues.map((value, idx) => clampCaptionScore(value - (width[idx] ?? 1) / 2)));
  const q90 = vectorToCaptionRecord(anchorValues.map((value, idx) => clampCaptionScore(value + (width[idx] ?? 1) / 2)));

  return {
    anchor,
    q10,
    q90,
    width: vectorToCaptionRecord(width),
    categories: categoriesFromV9BreakdownCaptions(anchor),
    total: totalFromV9BreakdownCaptions(anchor),
    dropoutMask,
    noiseStd: mode === 'teacher_forcing' || mode === 'baseline' || mode === 'full_dropout' ? 0 : options.noiseStd,
  } satisfies AnchorPayload;
};

const orderedPredictionRange = (p10: number, p50: number, p90: number) => {
  const mid = clampCaptionScore(p50);
  const low = clampCaptionScore(Math.min(p10, mid));
  const high = clampCaptionScore(Math.max(p90, mid));
  return { low, mid, high };
};

const makeV9ModelAnchor = (
  model: V9SubcaptionModel,
  row: MlRow,
  stat: readonly number[],
  baseline: Record<string, number>
) => {
  const prediction = model.predictOne({
    sequence: JSON.parse(String(row.x_sequence_json)) as number[][],
    staticFeatures: [...stat],
    judgeIndices: JSON.parse(String(row.judge_indices_json)) as number[],
    corpsId: Number(row.corps_id) || 0,
    agnosticShowId: Number(row.agnostic_show_id ?? 0) || 0,
    baselineRecap: captionRecordToVector(baseline),
    judgeBiasScale: 1,
    corpsScale: 1,
  });

  const anchorValues: number[] = [];
  const q10Values: number[] = [];
  const q90Values: number[] = [];
  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    const pred = prediction.captions[caption];
    const { low, mid, high } = orderedPredictionRange(pred.p10, pred.p50, pred.p90);
    q10Values.push(low);
    anchorValues.push(mid);
    q90Values.push(high);
  }

  const anchor = vectorToCaptionRecord(anchorValues);
  return {
    anchor,
    q10: vectorToCaptionRecord(q10Values),
    q90: vectorToCaptionRecord(q90Values),
    width: vectorToCaptionRecord(
      q90Values.map((value, idx) => Number((value - (q10Values[idx] ?? value)).toFixed(4)))
    ),
    categories: categoriesFromV9BreakdownCaptions(anchor),
    total: totalFromV9BreakdownCaptions(anchor),
    dropoutMask: Object.fromEntries(V9_BREAKDOWN_CAPTIONS.map((caption) => [caption, false])) as Record<
      string,
      boolean
    >,
    noiseStd: 0,
  } satisfies AnchorPayload;
};

const sha256File = (filePath: string) => {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const resolveModelConfig = async (args: ReturnType<typeof parseArgs>) => {
  if (!args.requestedModelDir) {
    return {
      model: undefined,
      sourceModelId: args.sourceModelId ?? DEFAULT_SOURCE_MODEL_ID,
      sourceModelPath: args.sourceModelPath,
      sourceModelCardSha256: args.sourceModelCardSha256,
    };
  }

  const modelRoot =
    args.requestedModelDir === 'latest' ? findLatestV9SubcaptionModelDir() : args.requestedModelDir;
  if (!modelRoot) throw new Error('No V9 model found. Pass --model-dir <path> or train a V9 model.');
  const model = await loadV9SubcaptionModel(modelRoot, { checkpoint: args.checkpoint });
  const modelJsonPath = path.resolve(model.modelDir, 'model.json');
  const sourceModelCardSha256 = args.sourceModelCardSha256 ?? sha256File(modelJsonPath);
  const sourceModelPath = args.sourceModelPath ?? model.modelDir;
  const modelName = path.basename(path.resolve(model.modelDir));
  const sourceModelId = args.sourceModelId ?? `v9-real-${modelName}-${sourceModelCardSha256.slice(0, 12)}`;
  return { model, sourceModelId, sourceModelPath, sourceModelCardSha256 };
};

const ensureTable = async (client: ReturnType<typeof createClient>) => {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v9_breakdown (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER NOT NULL,
      x_sequence_json TEXT NOT NULL,
      x_static_json TEXT NOT NULL,
      judge_indices_json TEXT NOT NULL,
      agnostic_show_id INTEGER NOT NULL DEFAULT 0,
      baseline_recap_json TEXT NOT NULL,
      v9_pred_recap_json TEXT NOT NULL,
      v9_pred_q10_json TEXT NOT NULL,
      v9_pred_q90_json TEXT NOT NULL,
      v9_pred_category_json TEXT NOT NULL,
      v9_pred_total REAL NOT NULL,
      v9_interval_width_json TEXT NOT NULL,
      anchor_mode TEXT NOT NULL,
      anchor_dropout_mask_json TEXT NOT NULL,
      anchor_noise_std REAL NOT NULL DEFAULT 0,
      y_caption_json TEXT NOT NULL,
      y_subcaption_json TEXT NOT NULL,
      y_subcaption_mask_json TEXT NOT NULL,
      y_category_json TEXT NOT NULL,
      y_total REAL NOT NULL,
      split TEXT NOT NULL,
      builder_version TEXT NOT NULL,
      source_v9_model_id TEXT NOT NULL,
      source_v9_model_path TEXT,
      source_v9_model_card_sha256 TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (competition_slug, corps_key, source_v9_model_id, anchor_mode)
    )
  `);
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

const validateV9Row = (row: MlRow) => {
  const sequence = JSON.parse(String(row.x_sequence_json)) as number[][];
  const stat = JSON.parse(String(row.x_static_json)) as number[];
  const judges = JSON.parse(String(row.judge_indices_json)) as number[];
  const recap = JSON.parse(String(row.y_recap_json)) as Record<string, number>;

  if (
    sequence.length !== EXPECTED_SEQUENCE_STEPS ||
    sequence.some((step) => !Array.isArray(step) || step.length !== EXPECTED_SEQUENCE_DIM)
  ) {
    throw new Error(`Bad sequence dimensions for ${row.competition_slug}/${row.corps_key}`);
  }
  if (!Array.isArray(stat) || stat.length !== EXPECTED_STATIC_DIM) {
    throw new Error(`Bad static dimensions for ${row.competition_slug}/${row.corps_key}`);
  }
  if (!Array.isArray(judges) || judges.length !== EXPECTED_JUDGE_DIM) {
    throw new Error(`Bad judge dimensions for ${row.competition_slug}/${row.corps_key}`);
  }
  if (
    V9_BREAKDOWN_CAPTIONS.some(
      (caption) => !Number.isFinite(recap[caption]) || recap[caption] <= 0 || recap[caption] > 20
    )
  ) {
    throw new Error(`Bad caption target for ${row.competition_slug}/${row.corps_key}`);
  }

  return { stat, recap };
};

const insertRows = async (client: ReturnType<typeof createClient>, rows: BuildRow[]) => {
  for (const row of rows) {
    await client.execute({
      sql: `
        INSERT OR REPLACE INTO ml_sequence_rows_v9_breakdown (
          season, competition_slug, competition_date, division_name, corps_key, corps_id,
          x_sequence_json, x_static_json, judge_indices_json, agnostic_show_id,
          baseline_recap_json, v9_pred_recap_json, v9_pred_q10_json, v9_pred_q90_json,
          v9_pred_category_json, v9_pred_total, v9_interval_width_json,
          anchor_mode, anchor_dropout_mask_json, anchor_noise_std,
          y_caption_json, y_subcaption_json, y_subcaption_mask_json, y_category_json, y_total,
          split, builder_version, source_v9_model_id, source_v9_model_path,
          source_v9_model_card_sha256, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
        )
      `,
      args: [
        row.season,
        row.competition_slug,
        row.competition_date,
        row.division_name,
        row.corps_key,
        row.corps_id,
        row.x_sequence_json,
        row.x_static_json,
        row.judge_indices_json,
        row.agnostic_show_id,
        row.baseline_recap_json,
        row.v9_pred_recap_json,
        row.v9_pred_q10_json,
        row.v9_pred_q90_json,
        row.v9_pred_category_json,
        row.v9_pred_total,
        row.v9_interval_width_json,
        row.anchor_mode,
        row.anchor_dropout_mask_json,
        row.anchor_noise_std,
        row.y_caption_json,
        row.y_subcaption_json,
        row.y_subcaption_mask_json,
        row.y_category_json,
        row.y_total,
        row.split,
        row.builder_version,
        row.source_v9_model_id,
        row.source_v9_model_path,
        row.source_v9_model_card_sha256,
        row.created_at,
      ],
    });
  }
};

const main = async () => {
  const args = parseArgs();
  const modelConfig = await resolveModelConfig(args);
  if (args.modes.includes('v9_predicted') && !modelConfig.model) {
    throw new Error('anchor mode v9_predicted requires --model-dir latest|<path>.');
  }
  const client = createClient({ url: `file:${args.dbPath}` });
  const subcaptionByKey = await loadSubcaptionRows(client);
  const mlResult = await client.execute(`
    SELECT season, competition_slug, competition_date, division_name, corps_key, corps_id,
           x_sequence_json, x_static_json, judge_indices_json, y_recap_json, y_total,
           agnostic_show_id, split
    FROM ml_sequence_rows_v9_subcaption
  `);

  const createdAt = new Date().toISOString();
  const buildRows: BuildRow[] = [];
  let skippedNoPairs = 0;
  let skippedInvalid = 0;
  let scaleRepairs = 0;
  let scaleExclusions = 0;
  const sourceRows = (mlResult.rows as unknown as MlRow[]).slice(
    0,
    args.maxRows > 0 ? args.maxRows : mlResult.rows.length
  );

  for (const raw of sourceRows) {
    try {
      const { stat, recap } = validateV9Row(raw);
      const aggregate = aggregateV9BreakdownSubcaptions(
        subcaptionByKey.get(`${raw.competition_slug}|${raw.corps_key}`) ?? [],
        recap
      );
      scaleRepairs += aggregate.scaleRepairs;
      scaleExclusions += aggregate.scaleExclusions;
      const validPairCount = V9_BREAKDOWN_CAPTIONS.filter(
        (caption) => aggregate.mask[caption].pair
      ).length;
      if (validPairCount === 0) {
        skippedNoPairs += 1;
        continue;
      }

      const baseline = readBaselineFromStatic(stat, recap);
      const yCategories = categoriesFromV9BreakdownCaptions(recap);
      const rowSeed = [...raw.competition_slug, ...raw.corps_key].reduce(
        (sum, char) => sum + char.charCodeAt(0),
        Number(raw.season) || 42
      );

      for (const [modeIdx, mode] of args.modes.entries()) {
        const anchor =
          mode === 'v9_predicted' && modelConfig.model
            ? makeV9ModelAnchor(modelConfig.model, raw, stat, baseline)
            : makeAnchor(mode, recap, baseline, {
                noiseStd: args.noiseStd,
                partialDropoutRate: args.partialDropoutRate,
                seed: rowSeed + modeIdx * 1009,
              });

        buildRows.push({
          season: String(raw.season),
          competition_slug: String(raw.competition_slug),
          competition_date: String(raw.competition_date),
          division_name: String(raw.division_name),
          corps_key: String(raw.corps_key),
          corps_id: Number(raw.corps_id),
          x_sequence_json: String(raw.x_sequence_json),
          x_static_json: String(raw.x_static_json),
          judge_indices_json: String(raw.judge_indices_json),
          agnostic_show_id: Number(raw.agnostic_show_id ?? 0),
          baseline_recap_json: JSON.stringify(baseline),
          v9_pred_recap_json: JSON.stringify(anchor.anchor),
          v9_pred_q10_json: JSON.stringify(anchor.q10),
          v9_pred_q90_json: JSON.stringify(anchor.q90),
          v9_pred_category_json: JSON.stringify(anchor.categories),
          v9_pred_total: Number(anchor.total.toFixed(4)),
          v9_interval_width_json: JSON.stringify(anchor.width),
          anchor_mode: mode,
          anchor_dropout_mask_json: JSON.stringify(anchor.dropoutMask),
          anchor_noise_std: anchor.noiseStd,
          y_caption_json: JSON.stringify(recap),
          y_subcaption_json: JSON.stringify(aggregate.target),
          y_subcaption_mask_json: JSON.stringify(aggregate.mask),
          y_category_json: JSON.stringify(yCategories),
          y_total: Number(raw.y_total),
          split: String(raw.split),
          builder_version: BUILDER_VERSION,
          source_v9_model_id: modelConfig.sourceModelId,
          source_v9_model_path: modelConfig.sourceModelPath ?? null,
          source_v9_model_card_sha256: modelConfig.sourceModelCardSha256 ?? null,
          created_at: createdAt,
        });
      }
    } catch {
      skippedInvalid += 1;
    }
  }

  if (args.apply) {
    await ensureTable(client);
    await client.execute('BEGIN IMMEDIATE');
    try {
      await client.execute({
        sql: `DELETE FROM ml_sequence_rows_v9_breakdown WHERE source_v9_model_id = ?`,
        args: [modelConfig.sourceModelId],
      });
      await insertRows(client, buildRows);
      await client.execute('COMMIT');
    } catch (error) {
      await client.execute('ROLLBACK');
      throw error;
    }
  }

  const report = {
    generated_at: createdAt,
    db_path: args.dbPath,
    applied: args.apply,
    source_v9_model_id: modelConfig.sourceModelId,
    source_v9_model_path: modelConfig.sourceModelPath ?? null,
    source_v9_model_card_sha256: modelConfig.sourceModelCardSha256 ?? null,
    checkpoint: args.checkpoint,
    anchor_modes: args.modes,
    source_rows: mlResult.rows.length,
    selected_source_rows: sourceRows.length,
    build_rows: buildRows.length,
    skipped_no_valid_subcaption_pairs: skippedNoPairs,
    skipped_invalid_v9_rows: skippedInvalid,
    scale_repairs: scaleRepairs,
    scale_exclusions: scaleExclusions,
  };

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(
    `${args.apply ? 'Built' : 'Dry run for'} ${buildRows.length} V9 breakdown rows from ${sourceRows.length} selected V9 rows.`
  );
  console.log(`Report written to ${args.output}`);
  modelConfig.model?.dispose();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
