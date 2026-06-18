import * as tf from '@tensorflow/tfjs-node';
import '@tensorflow/tfjs-backend-cpu';
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V9_RAW_STATIC_DIM } from './v9FeatureModes.js';
import {
  extractV9BreakdownPriorFeatures,
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
} from './v9BreakdownData.js';

const MODEL_DIR = './models/v9_breakdown';
const LOG_PATH = './results/v9-breakdown-training-log.csv';
const SEQ_LEN = 15;
const FEAT_DIM = 101;
const STATIC_DIM = V9_RAW_STATIC_DIM;
const CAPTION_COUNT = V9_BREAKDOWN_CAPTIONS.length;
const UNK_CORPS_ID = 0;
const DEFAULT_SOURCE_MODEL_ID = 'anchor-synthetic-v9-breakdown-mvp';

type AnchorMode =
  | 'teacher_forcing'
  | 'synthetic_noisy'
  | 'v9_predicted_noisy'
  | 'baseline'
  | 'partial_synthetic_dropout'
  | 'partial_dropout'
  | 'full_dropout';

type Args = {
  dbPath: string;
  sourceModelId: string;
  trialId: string;
  epochs: number;
  batchSize: number;
  learningRate: number;
  maxRows?: number;
  seed: number;
  valMode: 'split' | 'date-forward';
  valSplit: number;
  dropout: number;
  outputReport: string;
  evalAnchorModes: string[];
  samplesPerEpoch?: number;
  sequenceUnits: number;
  judgeEmbeddingDim: number;
  judgePanelUnits: number;
  trunkUnits: number;
  trunkDepth: number;
  residualScale: number;
};

type RawDbRow = {
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
  v9_interval_width_json: string;
  anchor_mode: AnchorMode;
  anchor_dropout_mask_json: string;
  anchor_noise_std: number;
  y_subcaption_json: string;
  y_subcaption_mask_json: string;
  split: string;
};

type Sample = {
  sequence: number[][];
  staticFeatures: number[];
  judgeIndices: number[];
  corpsId: number;
  agnosticShowId: number;
  anchor: number[];
  q10: number[];
  q90: number[];
  width: number[];
  baseline: number[];
  anchorMask: number[];
  priorBreakdown: number[];
  targetShare: number[];
  targetContent: number[];
  targetAchievement: number[];
  pairMask: number[];
  historicalShare: number[];
  priorShare: number[];
  split: string;
  dateMs: number;
  divisionName: string;
  anchorMode: string;
};

type Batch = {
  xs: Record<string, tf.Tensor>;
  ys: {
    targetShare: tf.Tensor2D;
    targetContent: tf.Tensor2D;
    targetAchievement: tf.Tensor2D;
    pairMask: tf.Tensor2D;
    anchor: tf.Tensor2D;
  };
  size: number;
};

type SourceV9Metadata = {
  source_v9_model_id: string;
  source_v9_model_path: string | null;
  source_v9_model_card_sha256: string | null;
  anchor_modes: string[];
  row_count: number;
};

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const idx = raw.indexOf(name);
    if (idx === -1) return fallback;
    return raw[idx + 1] ?? fallback;
  };

  const maxRows = get('--maxRows');
  const valMode = get('--val-mode', 'split') as Args['valMode'];

  return {
    dbPath: get('--db', 'dci-relational.db')!,
    sourceModelId: get('--source-model-id', DEFAULT_SOURCE_MODEL_ID)!,
    trialId: get('--trial-id', `run_${Date.now()}`)!,
    epochs: Number(get('--epochs', '80')),
    batchSize: Number(get('--batch', '128')),
    learningRate: Number(get('--lr', '0.001')),
    maxRows: maxRows ? Number(maxRows) : undefined,
    seed: Number(get('--seed', '42')),
    valMode,
    valSplit: Number(get('--val-split', '0.1')),
    dropout: Number(get('--dropout', '0.25')),
    outputReport: get('--output-report', 'eval_report.json')!,
    evalAnchorModes: (get(
      '--eval-anchor-modes',
      'v9_predicted,synthetic_noisy,baseline,partial_synthetic_dropout'
    ) ?? '')
      .split(',')
      .map((mode) => mode.trim())
      .filter(Boolean),
    samplesPerEpoch: get('--samples-per-epoch')
      ? Number(get('--samples-per-epoch'))
      : undefined,
    sequenceUnits: Number(get('--sequence-units', '192')),
    judgeEmbeddingDim: Number(get('--judge-embedding-dim', '16')),
    judgePanelUnits: Number(get('--judge-panel-units', '128')),
    trunkUnits: Number(get('--trunk-units', '512')),
    trunkDepth: Number(get('--trunk-depth', '3')),
    residualScale: Number(get('--residual-scale', '0.12')),
  };
};

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};

const shuffle = <T>(values: readonly T[], seed: number) => {
  const rng = seededRandom(seed);
  const copy = [...values];
  for (let idx = copy.length - 1; idx > 0; idx--) {
    const swapIdx = Math.floor(rng() * (idx + 1));
    [copy[idx], copy[swapIdx]] = [copy[swapIdx]!, copy[idx]!];
  }
  return copy;
};

const captionVector = (record: Record<string, number>) =>
  V9_BREAKDOWN_CAPTIONS.map((caption) => Number(record[caption] ?? 0));

const normalizeAnchor = (value: number) => value / 20;
const normalizeWidth = (value: number) => value / 4;

const extractPriorBreakdown = (staticFeatures: readonly number[]) => {
  const priorFeatures = extractV9BreakdownPriorFeatures(staticFeatures);
  return [
    ...priorFeatures.lastContent,
    ...priorFeatures.lastAchievement,
    ...priorFeatures.emaContent,
    ...priorFeatures.emaAchievement,
  ];
};

class ShareResidualLayer extends tf.layers.Layer {
  static className = 'ShareResidualLayer';
  private residualScale: number;

  constructor(config: { residualScale?: number; name?: string }) {
    super(config);
    this.residualScale = config.residualScale ?? 0.08;
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0];
  }

  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [priorShare, residual] = inputs as [tf.Tensor, tf.Tensor];
      return tf.clipByValue(tf.add(priorShare, tf.mul(residual, this.residualScale)), 0.01, 0.99);
    });
  }

  getConfig() {
    return { ...super.getConfig(), residualScale: this.residualScale };
  }
}

tf.serialization.registerClass(ShareResidualLayer);

const sampleFromRow = (row: RawDbRow): Sample | null => {
  const sequence = JSON.parse(row.x_sequence_json) as number[][];
  const staticFeatures = JSON.parse(row.x_static_json) as number[];
  const judgeIndices = JSON.parse(row.judge_indices_json) as number[];
  const anchorRecord = JSON.parse(row.v9_pred_recap_json) as Record<string, number>;
  const q10Record = JSON.parse(row.v9_pred_q10_json) as Record<string, number>;
  const q90Record = JSON.parse(row.v9_pred_q90_json) as Record<string, number>;
  const widthRecord = JSON.parse(row.v9_interval_width_json) as Record<string, number>;
  const baselineRecord = JSON.parse(row.baseline_recap_json) as Record<string, number>;
  const dropoutMask = JSON.parse(row.anchor_dropout_mask_json) as Record<string, boolean>;
  const target = JSON.parse(row.y_subcaption_json) as Record<
    V9BreakdownCaption,
    { content: number; achievement: number }
  >;
  const mask = JSON.parse(row.y_subcaption_mask_json) as Record<V9BreakdownCaption, { pair: boolean }>;

  if (
    sequence.length !== SEQ_LEN ||
    sequence.some((step) => !Array.isArray(step) || step.length !== FEAT_DIM) ||
    staticFeatures.length !== STATIC_DIM ||
    judgeIndices.length !== CAPTION_COUNT
  ) {
    return null;
  }

  const anchor = captionVector(anchorRecord);
  const q10 = captionVector(q10Record);
  const q90 = captionVector(q90Record);
  const width = captionVector(widthRecord);
  const baseline = captionVector(baselineRecord);
  const anchorMask = V9_BREAKDOWN_CAPTIONS.map((caption) => (dropoutMask[caption] ? 0 : 1));
  const targetContent = V9_BREAKDOWN_CAPTIONS.map((caption) => target[caption]?.content ?? 0);
  const targetAchievement = V9_BREAKDOWN_CAPTIONS.map((caption) => target[caption]?.achievement ?? 0);
  const pairMask = V9_BREAKDOWN_CAPTIONS.map((caption) => (mask[caption]?.pair ? 1 : 0));
  const targetShare = V9_BREAKDOWN_CAPTIONS.map((caption, idx) => {
    const total = (target[caption]?.content ?? 0) + (target[caption]?.achievement ?? 0);
    if (total <= 0 || pairMask[idx] === 0) return 0.5;
    return (target[caption]?.content ?? 0) / total;
  });

  if (pairMask.every((value) => value === 0)) return null;

  return {
    sequence,
    staticFeatures,
    judgeIndices,
    corpsId: Number(row.corps_id) || UNK_CORPS_ID,
    agnosticShowId: Number(row.agnostic_show_id) || 0,
    anchor,
    q10,
    q90,
    width,
    baseline,
    anchorMask,
    priorBreakdown: extractPriorBreakdown(staticFeatures),
    targetShare,
    targetContent,
    targetAchievement,
    pairMask,
    historicalShare: new Array(CAPTION_COUNT).fill(0.5),
    priorShare: new Array(CAPTION_COUNT).fill(0.5),
    split: String(row.split),
    dateMs: new Date(row.competition_date).getTime(),
    divisionName: String(row.division_name),
    anchorMode: String(row.anchor_mode),
  };
};

const loadSamples = async (args: Args) => {
  const client = createClient({ url: `file:${args.dbPath}` });
  const result = await client.execute({
    sql: `
      SELECT season, competition_slug, competition_date, division_name, corps_key, corps_id,
             x_sequence_json, x_static_json, judge_indices_json, agnostic_show_id,
             baseline_recap_json, v9_pred_recap_json, v9_pred_q10_json, v9_pred_q90_json,
             v9_interval_width_json, anchor_mode, anchor_dropout_mask_json, anchor_noise_std,
             y_subcaption_json, y_subcaption_mask_json, split
      FROM ml_sequence_rows_v9_breakdown
      WHERE source_v9_model_id = ?
      ORDER BY competition_date, competition_slug, corps_key, anchor_mode
    `,
    args: [args.sourceModelId],
  });
  const rows = result.rows as unknown as RawDbRow[];
  client.close();
  const limited = args.maxRows ? shuffle(rows, args.seed).slice(0, args.maxRows) : rows;
  return limited.map(sampleFromRow).filter((sample): sample is Sample => sample != null);
};

const loadSourceV9Metadata = async (args: Args): Promise<SourceV9Metadata> => {
  const client = createClient({ url: `file:${args.dbPath}` });
  const result = await client.execute({
    sql: `
      SELECT source_v9_model_id, source_v9_model_path, source_v9_model_card_sha256,
             anchor_mode, COUNT(*) AS row_count
      FROM ml_sequence_rows_v9_breakdown
      WHERE source_v9_model_id = ?
      GROUP BY source_v9_model_id, source_v9_model_path, source_v9_model_card_sha256, anchor_mode
      ORDER BY anchor_mode
    `,
    args: [args.sourceModelId],
  });
  client.close();
  const rows = result.rows as unknown as Array<{
    source_v9_model_id: string;
    source_v9_model_path: string | null;
    source_v9_model_card_sha256: string | null;
    anchor_mode: string;
    row_count: number;
  }>;
  const first = rows[0];
  return {
    source_v9_model_id: args.sourceModelId,
    source_v9_model_path: first?.source_v9_model_path ?? null,
    source_v9_model_card_sha256: first?.source_v9_model_card_sha256 ?? null,
    anchor_modes: rows.map((row) => String(row.anchor_mode)),
    row_count: rows.reduce((sum, row) => sum + Number(row.row_count ?? 0), 0),
  };
};

const splitSamples = (samples: Sample[], args: Args) => {
  if (args.valMode === 'date-forward') {
    const sortedDates = [...new Set(samples.map((sample) => sample.dateMs).filter(Number.isFinite))].sort(
      (a, b) => a - b
    );
    const cutoffIdx = Math.max(0, Math.floor(sortedDates.length * (1 - args.valSplit)));
    const cutoff = sortedDates[cutoffIdx] ?? Number.POSITIVE_INFINITY;
    const train = samples.filter((sample) => sample.split !== 'test' && sample.dateMs < cutoff);
    const validation = samples.filter((sample) => sample.split !== 'test' && sample.dateMs >= cutoff);
    const test = samples.filter((sample) => sample.split === 'test');
    return { train, validation, test };
  }

  return {
    train: samples.filter((sample) => sample.split === 'train'),
    validation: samples.filter((sample) => sample.split === 'val'),
    test: samples.filter((sample) => sample.split === 'test'),
  };
};

const priorKey = (divisionName: string, caption: V9BreakdownCaption) => `${divisionName}|${caption}`;

const buildRatioPriors = (trainSamples: readonly Sample[]) => {
  const scoped = new Map<string, { sum: number; count: number }>();
  const global = new Map<V9BreakdownCaption, { sum: number; count: number }>();

  for (const sample of trainSamples) {
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      if ((sample.pairMask[idx] ?? 0) <= 0) continue;
      const caption = V9_BREAKDOWN_CAPTIONS[idx]!;
      const share = sample.targetShare[idx] ?? 0.5;
      const key = priorKey(sample.divisionName, caption);
      const current = scoped.get(key) ?? { sum: 0, count: 0 };
      current.sum += share;
      current.count += 1;
      scoped.set(key, current);

      const globalCurrent = global.get(caption) ?? { sum: 0, count: 0 };
      globalCurrent.sum += share;
      globalCurrent.count += 1;
      global.set(caption, globalCurrent);
    }
  }

  const lookup = (divisionName: string, caption: V9BreakdownCaption) => {
    const current = scoped.get(priorKey(divisionName, caption));
    if (current?.count) return current.sum / current.count;
    const fallback = global.get(caption);
    if (fallback?.count) return fallback.sum / fallback.count;
    return 0.5;
  };

  return { lookup };
};

const applyRatioPriors = (samples: readonly Sample[], priors: ReturnType<typeof buildRatioPriors>) => {
  for (const sample of samples) {
    sample.historicalShare = V9_BREAKDOWN_CAPTIONS.map((caption) =>
      priors.lookup(sample.divisionName, caption)
    );
    const priorFeatures = extractV9BreakdownPriorFeatures(sample.staticFeatures);
    sample.priorShare = V9_BREAKDOWN_CAPTIONS.map((caption, idx) => {
      const historicalShare = sample.historicalShare[idx] ?? priors.lookup(sample.divisionName, caption);
      const lastShare = priorFeatures.lastShare[idx];
      const emaShare = priorFeatures.emaShare[idx];

      if (lastShare != null && emaShare != null) {
        return historicalShare * 0.5 + emaShare * 0.3 + lastShare * 0.2;
      }
      if (emaShare != null) return historicalShare * 0.65 + emaShare * 0.35;
      if (lastShare != null) return historicalShare * 0.75 + lastShare * 0.25;
      return historicalShare;
    });
  }
};

const filterEvalSamples = (samples: readonly Sample[], modes: readonly string[]) => {
  const allowed = new Set(modes);
  const filtered = samples.filter((sample) => allowed.has(sample.anchorMode));
  return filtered.length ? filtered : [...samples];
};

const buildModel = (args: Args, corpsCount: number, showCount: number) => {
  const sequenceInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: 'sequence' });
  const staticInput = tf.input({ shape: [STATIC_DIM], name: 'static' });
  const judgeInput = tf.input({ shape: [CAPTION_COUNT], dtype: 'int32', name: 'judge_ids' });
  const corpsInput = tf.input({ shape: [1], dtype: 'int32', name: 'corps_id' });
  const showInput = tf.input({ shape: [1], dtype: 'int32', name: 'agnostic_show_id' });
  const anchorInput = tf.input({ shape: [CAPTION_COUNT], name: 'anchor' });
  const q10Input = tf.input({ shape: [CAPTION_COUNT], name: 'q10' });
  const q90Input = tf.input({ shape: [CAPTION_COUNT], name: 'q90' });
  const widthInput = tf.input({ shape: [CAPTION_COUNT], name: 'width' });
  const baselineInput = tf.input({ shape: [CAPTION_COUNT], name: 'baseline' });
  const anchorMaskInput = tf.input({ shape: [CAPTION_COUNT], name: 'anchor_mask' });
  const priorShareInput = tf.input({ shape: [CAPTION_COUNT], name: 'prior_share' });
  const priorBreakdownInput = tf.input({ shape: [CAPTION_COUNT * 4], name: 'prior_breakdown' });

  const sequenceFlat = tf.layers.flatten().apply(sequenceInput) as tf.SymbolicTensor;
  const sequenceDense = tf.layers
    .dense({ units: args.sequenceUnits, activation: 'relu', name: 'sequence_projection' })
    .apply(sequenceFlat) as tf.SymbolicTensor;

  const judgeEmbedding = tf.layers
    .embedding({ inputDim: 1500, outputDim: args.judgeEmbeddingDim, name: 'judge_embedding' })
    .apply(judgeInput) as tf.SymbolicTensor;
  const judgeFlat = tf.layers.flatten().apply(judgeEmbedding) as tf.SymbolicTensor;
  const judgePanelDense = tf.layers
    .dense({
      units: args.judgePanelUnits,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
      name: 'judge_panel_projection',
    })
    .apply(judgeFlat) as tf.SymbolicTensor;

  const corpsEmbedding = tf.layers
    .embedding({ inputDim: Math.max(corpsCount + 1, 256), outputDim: 24, name: 'corps_embedding' })
    .apply(corpsInput) as tf.SymbolicTensor;
  const corpsFlat = tf.layers.flatten().apply(corpsEmbedding) as tf.SymbolicTensor;

  const showEmbedding = tf.layers
    .embedding({ inputDim: Math.max(showCount + 1, 512), outputDim: 16, name: 'show_embedding' })
    .apply(showInput) as tf.SymbolicTensor;
  const showFlat = tf.layers.flatten().apply(showEmbedding) as tf.SymbolicTensor;

  const normalizedAnchors = tf.layers
    .concatenate({ name: 'anchor_context' })
    .apply([
      anchorInput,
      q10Input,
      q90Input,
      widthInput,
      baselineInput,
      anchorMaskInput,
      priorShareInput,
      priorBreakdownInput,
    ]) as tf.SymbolicTensor;

  const combined = tf.layers
    .concatenate({ name: 'combined' })
    .apply([sequenceDense, staticInput, judgePanelDense, corpsFlat, showFlat, normalizedAnchors]) as tf.SymbolicTensor;

  let trunk = combined;
  for (let idx = 0; idx < Math.max(1, args.trunkDepth); idx++) {
    const units = Math.max(64, Math.round(args.trunkUnits / Math.max(1, idx * 0.5 + 1)));
    const dense = tf.layers
      .dense({
        units,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
        name: `trunk_${idx + 1}`,
      })
      .apply(trunk) as tf.SymbolicTensor;
    trunk = tf.layers
      .dropout({ rate: Math.max(0, Math.min(0.6, args.dropout * (idx === 0 ? 1 : 0.75))) })
      .apply(dense) as tf.SymbolicTensor;
  }

  const residual = tf.layers
    .dense({ units: CAPTION_COUNT, activation: 'tanh', name: 'content_share_residual' })
    .apply(trunk) as tf.SymbolicTensor;
  const share = new ShareResidualLayer({ name: 'content_share', residualScale: args.residualScale }).apply([
    priorShareInput,
    residual,
  ]) as tf.SymbolicTensor;

  return tf.model({
    inputs: [
      sequenceInput,
      staticInput,
      judgeInput,
      corpsInput,
      showInput,
      anchorInput,
      q10Input,
      q90Input,
      widthInput,
      baselineInput,
      anchorMaskInput,
      priorShareInput,
      priorBreakdownInput,
    ],
    outputs: share,
  });
};

const makeBatch = (samples: readonly Sample[]): Batch => {
  const size = samples.length;
  const sequence = new Float32Array(size * SEQ_LEN * FEAT_DIM);
  const staticFeatures = new Float32Array(size * STATIC_DIM);
  const judgeIds = new Int32Array(size * CAPTION_COUNT);
  const corpsIds = new Int32Array(size);
  const showIds = new Int32Array(size);
  const anchor = new Float32Array(size * CAPTION_COUNT);
  const q10 = new Float32Array(size * CAPTION_COUNT);
  const q90 = new Float32Array(size * CAPTION_COUNT);
  const width = new Float32Array(size * CAPTION_COUNT);
  const baseline = new Float32Array(size * CAPTION_COUNT);
  const anchorMask = new Float32Array(size * CAPTION_COUNT);
  const priorShare = new Float32Array(size * CAPTION_COUNT);
  const priorBreakdown = new Float32Array(size * CAPTION_COUNT * 4);
  const targetShare = new Float32Array(size * CAPTION_COUNT);
  const targetContent = new Float32Array(size * CAPTION_COUNT);
  const targetAchievement = new Float32Array(size * CAPTION_COUNT);
  const pairMask = new Float32Array(size * CAPTION_COUNT);

  for (let rowIdx = 0; rowIdx < size; rowIdx++) {
    const sample = samples[rowIdx]!;
    for (let stepIdx = 0; stepIdx < SEQ_LEN; stepIdx++) {
      for (let featIdx = 0; featIdx < FEAT_DIM; featIdx++) {
        sequence[rowIdx * SEQ_LEN * FEAT_DIM + stepIdx * FEAT_DIM + featIdx] =
          sample.sequence[stepIdx]?.[featIdx] ?? 0;
      }
    }
    for (let idx = 0; idx < STATIC_DIM; idx++) staticFeatures[rowIdx * STATIC_DIM + idx] = sample.staticFeatures[idx] ?? 0;
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      judgeIds[rowIdx * CAPTION_COUNT + idx] = sample.judgeIndices[idx] ?? 0;
      anchor[rowIdx * CAPTION_COUNT + idx] = normalizeAnchor(sample.anchor[idx] ?? 0);
      q10[rowIdx * CAPTION_COUNT + idx] = normalizeAnchor(sample.q10[idx] ?? 0);
      q90[rowIdx * CAPTION_COUNT + idx] = normalizeAnchor(sample.q90[idx] ?? 0);
      width[rowIdx * CAPTION_COUNT + idx] = normalizeWidth(sample.width[idx] ?? 0);
      baseline[rowIdx * CAPTION_COUNT + idx] = normalizeAnchor(sample.baseline[idx] ?? 0);
      anchorMask[rowIdx * CAPTION_COUNT + idx] = sample.anchorMask[idx] ?? 0;
      priorShare[rowIdx * CAPTION_COUNT + idx] = sample.priorShare[idx] ?? 0.5;
      targetShare[rowIdx * CAPTION_COUNT + idx] = sample.targetShare[idx] ?? 0.5;
      targetContent[rowIdx * CAPTION_COUNT + idx] = sample.targetContent[idx] ?? 0;
      targetAchievement[rowIdx * CAPTION_COUNT + idx] = sample.targetAchievement[idx] ?? 0;
      pairMask[rowIdx * CAPTION_COUNT + idx] = sample.pairMask[idx] ?? 0;
    }
    for (let idx = 0; idx < CAPTION_COUNT * 4; idx++) {
      priorBreakdown[rowIdx * CAPTION_COUNT * 4 + idx] = sample.priorBreakdown[idx] ?? 0;
    }
    corpsIds[rowIdx] = Math.max(0, sample.corpsId);
    showIds[rowIdx] = Math.max(0, sample.agnosticShowId);
  }

  return {
    size,
    xs: {
      sequence: tf.tensor3d(sequence, [size, SEQ_LEN, FEAT_DIM], 'float32'),
      static: tf.tensor2d(staticFeatures, [size, STATIC_DIM], 'float32'),
      judge_ids: tf.tensor2d(judgeIds, [size, CAPTION_COUNT], 'int32'),
      corps_id: tf.tensor2d(corpsIds, [size, 1], 'int32'),
      agnostic_show_id: tf.tensor2d(showIds, [size, 1], 'int32'),
      anchor: tf.tensor2d(anchor, [size, CAPTION_COUNT], 'float32'),
      q10: tf.tensor2d(q10, [size, CAPTION_COUNT], 'float32'),
      q90: tf.tensor2d(q90, [size, CAPTION_COUNT], 'float32'),
      width: tf.tensor2d(width, [size, CAPTION_COUNT], 'float32'),
      baseline: tf.tensor2d(baseline, [size, CAPTION_COUNT], 'float32'),
      anchor_mask: tf.tensor2d(anchorMask, [size, CAPTION_COUNT], 'float32'),
      prior_share: tf.tensor2d(priorShare, [size, CAPTION_COUNT], 'float32'),
      prior_breakdown: tf.tensor2d(priorBreakdown, [size, CAPTION_COUNT * 4], 'float32'),
    },
    ys: {
      targetShare: tf.tensor2d(targetShare, [size, CAPTION_COUNT], 'float32'),
      targetContent: tf.tensor2d(targetContent, [size, CAPTION_COUNT], 'float32'),
      targetAchievement: tf.tensor2d(targetAchievement, [size, CAPTION_COUNT], 'float32'),
      pairMask: tf.tensor2d(pairMask, [size, CAPTION_COUNT], 'float32'),
      anchor: tf.tensor2d(anchor, [size, CAPTION_COUNT], 'float32'),
    },
  };
};

const disposeBatch = (batch: Batch) => {
  Object.values(batch.xs).forEach((tensor) => tensor.dispose());
  Object.values(batch.ys).forEach((tensor) => tensor.dispose());
};

const modelInputs = (batch: Batch) => [
  batch.xs.sequence,
  batch.xs.static,
  batch.xs.judge_ids,
  batch.xs.corps_id,
  batch.xs.agnostic_show_id,
  batch.xs.anchor,
  batch.xs.q10,
  batch.xs.q90,
  batch.xs.width,
  batch.xs.baseline,
  batch.xs.anchor_mask,
  batch.xs.prior_share,
  batch.xs.prior_breakdown,
];

function* batches(samples: readonly Sample[], batchSize: number) {
  for (let idx = 0; idx < samples.length; idx += batchSize) {
    yield makeBatch(samples.slice(idx, idx + batchSize));
  }
}

const maskedMean = (values: tf.Tensor, mask: tf.Tensor) => {
  const denom = tf.maximum(tf.sum(mask), tf.scalar(1));
  return tf.div(tf.sum(tf.mul(values, mask)), denom);
};

const lossFor = (predShare: tf.Tensor, batch: Batch) =>
  tf.tidy(() => {
    const predContent = tf.mul(predShare, batch.ys.anchor);
    const predAchievement = tf.mul(tf.sub(1, predShare), batch.ys.anchor);

    const contentPtsLoss = maskedMean(
      tf.abs(tf.sub(predContent, tf.div(batch.ys.targetContent, 20))),
      batch.ys.pairMask
    );
    const achievementPtsLoss = maskedMean(
      tf.abs(tf.sub(predAchievement, tf.div(batch.ys.targetAchievement, 20))),
      batch.ys.pairMask
    );
    const shareLoss = maskedMean(tf.abs(tf.sub(predShare, batch.ys.targetShare)), batch.ys.pairMask);

    return tf.add(tf.add(contentPtsLoss, achievementPtsLoss), tf.mul(shareLoss, 0.25)) as tf.Scalar;
  });

const evaluate = (model: tf.LayersModel, samples: readonly Sample[], batchSize: number) => {
  let count = 0;
  let contentAbs = 0;
  let achievementAbs = 0;
  let shareAbs = 0;
  let sumAbs = 0;
  let anchorCaptionAbs = 0;

  for (const batch of batches(samples, batchSize)) {
    const pred = model.predict(modelInputs(batch)) as tf.Tensor2D;
    const data = tf.tidy(() => {
      const predContent = tf.mul(pred, batch.ys.anchor).mul(20);
      const predAchievement = tf.mul(tf.sub(1, pred), batch.ys.anchor).mul(20);
      const contentErr = tf.abs(tf.sub(predContent, batch.ys.targetContent));
      const achievementErr = tf.abs(tf.sub(predAchievement, batch.ys.targetAchievement));
      const shareErr = tf.abs(tf.sub(pred, batch.ys.targetShare));
      const sumErr = tf.abs(tf.sub(tf.add(predContent, predAchievement), batch.ys.anchor.mul(20)));
      const targetCaption = tf.add(batch.ys.targetContent, batch.ys.targetAchievement);
      const anchorCaptionErr = tf.abs(tf.sub(batch.ys.anchor.mul(20), targetCaption));
      return {
        content: contentErr.dataSync(),
        achievement: achievementErr.dataSync(),
        share: shareErr.dataSync(),
        sum: sumErr.dataSync(),
        anchorCaption: anchorCaptionErr.dataSync(),
        mask: batch.ys.pairMask.dataSync(),
      };
    });

    for (let idx = 0; idx < data.mask.length; idx++) {
      if ((data.mask[idx] ?? 0) <= 0) continue;
      count += 1;
      contentAbs += data.content[idx] ?? 0;
      achievementAbs += data.achievement[idx] ?? 0;
      shareAbs += data.share[idx] ?? 0;
      sumAbs += data.sum[idx] ?? 0;
      anchorCaptionAbs += data.anchorCaption[idx] ?? 0;
    }

    pred.dispose();
    disposeBatch(batch);
  }

  return {
    pairs: count,
    content_mae_pts: count ? contentAbs / count : 0,
    achievement_mae_pts: count ? achievementAbs / count : 0,
    subcaption_mae_pts: count ? (contentAbs + achievementAbs) / (count * 2) : 0,
    content_share_mae: count ? shareAbs / count : 0,
    anchor_caption_mae_pts: count ? anchorCaptionAbs / count : 0,
    anchor_sum_error_pts: count ? sumAbs / count : 0,
  };
};

const evaluateAllocator = (
  samples: readonly Sample[],
  shareFor: (sample: Sample, captionIdx: number) => number
) => {
  let count = 0;
  let contentAbs = 0;
  let achievementAbs = 0;
  let shareAbs = 0;
  let sumAbs = 0;
  let anchorCaptionAbs = 0;

  for (const sample of samples) {
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      if ((sample.pairMask[idx] ?? 0) <= 0) continue;
      const anchorTotal = sample.anchor[idx] ?? 0;
      if (anchorTotal <= 0) continue;
      const share = shareFor(sample, idx);
      const predContent = anchorTotal * share;
      const predAchievement = anchorTotal * (1 - share);
      const targetCaptionTotal = (sample.targetContent[idx] ?? 0) + (sample.targetAchievement[idx] ?? 0);
      count += 1;
      contentAbs += Math.abs(predContent - (sample.targetContent[idx] ?? 0));
      achievementAbs += Math.abs(predAchievement - (sample.targetAchievement[idx] ?? 0));
      shareAbs += Math.abs(share - (sample.targetShare[idx] ?? 0.5));
      sumAbs += Math.abs(predContent + predAchievement - anchorTotal);
      anchorCaptionAbs += Math.abs(anchorTotal - targetCaptionTotal);
    }
  }

  return {
    pairs: count,
    content_mae_pts: count ? contentAbs / count : 0,
    achievement_mae_pts: count ? achievementAbs / count : 0,
    subcaption_mae_pts: count ? (contentAbs + achievementAbs) / (count * 2) : 0,
    content_share_mae: count ? shareAbs / count : 0,
    anchor_caption_mae_pts: count ? anchorCaptionAbs / count : 0,
    anchor_sum_error_pts: count ? sumAbs / count : 0,
  };
};

const evaluateAllocatorSet = (samples: readonly Sample[]) => ({
  fixed_50_50: evaluateAllocator(samples, () => 0.5),
  historical_ratio: evaluateAllocator(samples, (sample, captionIdx) => sample.historicalShare[captionIdx] ?? 0.5),
  blended_prior_ratio: evaluateAllocator(samples, (sample, captionIdx) => sample.priorShare[captionIdx] ?? 0.5),
  oracle_target_share: evaluateAllocator(samples, (sample, captionIdx) => sample.targetShare[captionIdx] ?? 0.5),
});

type MetricSummary = ReturnType<typeof evaluate>;
type BaselineSet = ReturnType<typeof evaluateAllocatorSet>;

const safePct = (numerator: number, denominator: number) =>
  Math.abs(denominator) > 1e-9 ? numerator / denominator : null;

const compareToBaselines = (modelMetrics: MetricSummary, baselines: BaselineSet) => {
  const fifty = baselines.fixed_50_50;
  const oracle = baselines.oracle_target_share;
  const pointGain = fifty.subcaption_mae_pts - modelMetrics.subcaption_mae_pts;
  const pointCeiling = fifty.subcaption_mae_pts - oracle.subcaption_mae_pts;
  const shareGain = fifty.content_share_mae - modelMetrics.content_share_mae;
  const shareCeiling = fifty.content_share_mae;

  return {
    vs_50_50: {
      subcaption_mae_gain_pts: pointGain,
      subcaption_mae_gain_tenths: pointGain * 10,
      content_share_mae_gain: shareGain,
    },
    ceiling: {
      oracle_subcaption_mae_pts: oracle.subcaption_mae_pts,
      oracle_content_share_mae: oracle.content_share_mae,
      subcaption_mae_available_gain_pts: pointCeiling,
      subcaption_mae_available_gain_tenths: pointCeiling * 10,
      content_share_mae_available_gain: shareCeiling,
    },
    captured: {
      subcaption_mae_pct_of_ceiling: safePct(pointGain, pointCeiling),
      content_share_mae_pct_of_ceiling: safePct(shareGain, shareCeiling),
    },
  };
};

const evaluateModelByAnchorMode = (
  model: tf.LayersModel,
  samples: readonly Sample[],
  batchSize: number
) =>
  Object.fromEntries(
    [...new Set(samples.map((sample) => sample.anchorMode))]
      .sort()
      .map((mode) => [mode, evaluate(model, samples.filter((sample) => sample.anchorMode === mode), batchSize)])
  );

const evaluateAllocatorSetByAnchorMode = (samples: readonly Sample[]) =>
  Object.fromEntries(
    [...new Set(samples.map((sample) => sample.anchorMode))]
      .sort()
      .map((mode) => [mode, evaluateAllocatorSet(samples.filter((sample) => sample.anchorMode === mode))])
  );

const train = async () => {
  const args = parseArgs();
  await tf.setBackend('cpu');

  const allSamples = await loadSamples(args);
  const sourceV9 = await loadSourceV9Metadata(args);
  const { train, validation, test } = splitSamples(allSamples, args);
  if (!train.length || !validation.length) {
    throw new Error(`Need train and validation samples; got train=${train.length}, val=${validation.length}`);
  }
  const priors = buildRatioPriors(train);
  applyRatioPriors(allSamples, priors);

  const corpsCount = Math.max(UNK_CORPS_ID, ...allSamples.map((sample) => sample.corpsId)) + 1;
  const showCount = Math.max(0, ...allSamples.map((sample) => sample.agnosticShowId)) + 1;
  const model = buildModel(args, corpsCount, showCount);
  const optimizer = tf.train.adam(args.learningRate);

  const outputDir = path.join(MODEL_DIR, args.trialId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const epochValidationBaselines = evaluateAllocatorSet(validation);
  const logHeader =
    'trial_id,epoch,train_loss,val_subcaption_mae_pts,val_content_share_mae,val_anchor_sum_error_pts,val_vs_50_50_gain_pts,val_vs_50_50_gain_tenths,val_pct_point_ceiling,val_pct_share_ceiling\n';
  const trialLogPath = path.join(outputDir, 'training-log.csv');
  fs.writeFileSync(trialLogPath, logHeader);
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, logHeader);

  let bestPrimary = Number.POSITIVE_INFINITY;
  let bestSubcaption = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;

  for (let epoch = 1; epoch <= args.epochs; epoch++) {
    const shuffledEpochSamples = shuffle(train, args.seed + epoch);
    const epochSamples =
      args.samplesPerEpoch && args.samplesPerEpoch > 0
        ? shuffledEpochSamples.slice(0, Math.min(args.samplesPerEpoch, shuffledEpochSamples.length))
        : shuffledEpochSamples;
    let trainLossSum = 0;
    let trainCount = 0;

    for (const batch of batches(epochSamples, args.batchSize)) {
      const lossTensor = optimizer.minimize(() => {
        const pred = model.apply(modelInputs(batch), { training: true }) as tf.Tensor;
        return lossFor(pred, batch);
      }, true) as tf.Scalar;
      const loss = lossTensor.dataSync()[0] ?? 0;
      trainLossSum += loss * batch.size;
      trainCount += batch.size;
      lossTensor.dispose();
      disposeBatch(batch);
    }

    const valMetrics = evaluate(model, validation, args.batchSize);
    const valComparison = compareToBaselines(valMetrics, epochValidationBaselines);
    const trainLoss = trainCount ? trainLossSum / trainCount : 0;
    const logLine = `${args.trialId},${epoch},${trainLoss},${valMetrics.subcaption_mae_pts},${valMetrics.content_share_mae},${valMetrics.anchor_sum_error_pts},${valComparison.vs_50_50.subcaption_mae_gain_pts},${valComparison.vs_50_50.subcaption_mae_gain_tenths},${valComparison.captured.subcaption_mae_pct_of_ceiling ?? ''},${valComparison.captured.content_share_mae_pct_of_ceiling ?? ''}\n`;
    fs.appendFileSync(trialLogPath, logLine);
    fs.appendFileSync(LOG_PATH, logLine);
    console.log(
      `Epoch ${epoch}: train_loss=${trainLoss.toFixed(5)} val_subcaption_mae=${valMetrics.subcaption_mae_pts.toFixed(4)} val_share_mae=${valMetrics.content_share_mae.toFixed(4)} vs50=${valComparison.vs_50_50.subcaption_mae_gain_pts.toFixed(4)}pts/${valComparison.vs_50_50.subcaption_mae_gain_tenths.toFixed(3)}tenths ceiling=${((valComparison.captured.subcaption_mae_pct_of_ceiling ?? 0) * 100).toFixed(1)}% share_ceiling=${((valComparison.captured.content_share_mae_pct_of_ceiling ?? 0) * 100).toFixed(1)}%`
    );

    if (valMetrics.content_share_mae < bestPrimary) {
      bestPrimary = valMetrics.content_share_mae;
      bestSubcaption = valMetrics.subcaption_mae_pts;
      bestEpoch = epoch;
      await model.save(`file://${path.join(outputDir, 'best')}`);
    }
  }

  await model.save(`file://${outputDir}`);
  const bestModelPath = path.join(outputDir, 'best', 'model.json');
  const evalModel = fs.existsSync(bestModelPath)
    ? await tf.loadLayersModel(`file://${bestModelPath}`)
    : model;
  const finalValidation = evaluate(model, validation, args.batchSize);
  const finalTest = test.length ? evaluate(model, test, args.batchSize) : null;
  const evalValidation = filterEvalSamples(validation, args.evalAnchorModes);
  const evalTest = filterEvalSamples(test, args.evalAnchorModes);
  const v9PredictedValidation = validation.filter((sample) => sample.anchorMode === 'v9_predicted');
  const v9PredictedTest = test.filter((sample) => sample.anchorMode === 'v9_predicted');
  const bestValidation = evaluate(evalModel, validation, args.batchSize);
  const bestTest = test.length ? evaluate(evalModel, test, args.batchSize) : null;
  const productionLikeValidation = evaluate(evalModel, evalValidation, args.batchSize);
  const productionLikeTest = evalTest.length ? evaluate(evalModel, evalTest, args.batchSize) : null;
  const validationBaselines = evaluateAllocatorSet(evalValidation);
  const testBaselines = evalTest.length ? evaluateAllocatorSet(evalTest) : null;
  const productionLikeComparison = compareToBaselines(productionLikeValidation, validationBaselines);
  const productionLikeTestComparison =
    productionLikeTest && testBaselines ? compareToBaselines(productionLikeTest, testBaselines) : null;
  const v9PredictedEval = v9PredictedValidation.length
    ? {
        validation_rows: v9PredictedValidation.length,
        test_rows: v9PredictedTest.length,
        validation: evaluate(evalModel, v9PredictedValidation, args.batchSize),
        test: v9PredictedTest.length ? evaluate(evalModel, v9PredictedTest, args.batchSize) : null,
        validation_baselines: evaluateAllocatorSet(v9PredictedValidation),
        test_baselines: v9PredictedTest.length ? evaluateAllocatorSet(v9PredictedTest) : null,
      }
    : null;
  const v9PredictedEvalWithComparisons = v9PredictedEval
    ? {
        ...v9PredictedEval,
        validation_comparison: compareToBaselines(
          v9PredictedEval.validation,
          v9PredictedEval.validation_baselines
        ),
        test_comparison:
          v9PredictedEval.test && v9PredictedEval.test_baselines
            ? compareToBaselines(v9PredictedEval.test, v9PredictedEval.test_baselines)
            : null,
      }
    : null;
  const report = {
    generated_at: new Date().toISOString(),
    trainer: 'trainModelV9Breakdown.ts',
    primary_metric: 'content_share_mae',
    secondary_metric: 'subcaption_mae_pts',
    db_path: args.dbPath,
    source_v9_model_id: args.sourceModelId,
    source_v9: sourceV9,
    config: args,
    rows: {
      all: allSamples.length,
      train: train.length,
      validation: validation.length,
      test: test.length,
    },
    best: {
      epoch: bestEpoch,
      validation_content_share_mae: bestPrimary,
      validation_subcaption_mae_pts: bestSubcaption,
      validation: bestValidation,
      test: bestTest,
    },
    final_validation: finalValidation,
    final_test: finalTest,
    production_like_eval: {
      anchor_modes: args.evalAnchorModes,
      validation_rows: evalValidation.length,
      test_rows: evalTest.length,
      validation: productionLikeValidation,
      test: productionLikeTest,
      validation_comparison: productionLikeComparison,
      test_comparison: productionLikeTestComparison,
      validation_by_anchor_mode: evaluateModelByAnchorMode(evalModel, evalValidation, args.batchSize),
      test_by_anchor_mode: evalTest.length ? evaluateModelByAnchorMode(evalModel, evalTest, args.batchSize) : null,
    },
    v9_predicted_eval: v9PredictedEvalWithComparisons,
    validation_baselines: validationBaselines,
    test_baselines: testBaselines,
    validation_baselines_by_anchor_mode: evaluateAllocatorSetByAnchorMode(evalValidation),
    test_baselines_by_anchor_mode: evalTest.length ? evaluateAllocatorSetByAnchorMode(evalTest) : null,
  };

  fs.writeFileSync(path.join(outputDir, args.outputReport), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputDir, 'training-args.json'), JSON.stringify(args, null, 2));
  console.log(`Saved V9 breakdown model to ${outputDir}`);
};

train().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
