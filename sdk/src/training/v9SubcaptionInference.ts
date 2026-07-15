import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type Caption = (typeof CAPTIONS)[number];

const SEQ_LEN = 15;
const FEAT_DIM = 101;
const CAPTION_COUNT = CAPTIONS.length;
const DELTA_DIM = CAPTION_COUNT * 3;
const RECAP_DIM = CAPTION_COUNT;
const CATEGORY_DIM = 3;
const TOTAL_DIM = 1;
const RECAP_OFFSET_IN_FEATS = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;
const DEFAULT_TOTAL_STATIC_DIM = 187;
const UNK_CORPS_ID = 0;

export type TargetStats = {
  deltaMean: number[];
  deltaStd: number[];
  recapMean: number[];
  recapStd: number[];
  categoryMean: number[];
  categoryStd: number[];
  totalMean: number;
  totalStd: number;
};

const currentStats = () => {
  const stats = (globalThis as any).V9_SUBCAPTION_INFERENCE_STATS as TargetStats | undefined;
  if (!stats)
    throw new Error('V9 inference stats must be loaded before deserializing custom layers.');
  return stats;
};

export type V9PredictionInput = {
  sequence: number[][];
  staticFeatures: number[];
  sequenceMask?: Array<boolean | number>;
  judgeIndices?: number[];
  corpsId?: number;
  agnosticShowId?: number;
  baselineRecap?: number[];
  historyLen?: number;
  judgeBiasScale?: number;
  corpsScale?: number;
};

export type V9Prediction = {
  captions: Record<Caption, { p10: number; p50: number; p90: number; residualP50?: number }>;
  categories: { ge: number; visual: number; music: number };
  total: number;
};

class MaskedSoftmax extends tf.layers.Layer {
  static className = 'MaskedSoftmax';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as Array<Array<number | null>>)[0];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [scoresRaw, maskRaw] = inputs as tf.Tensor[];
      const scores = tf.reshape(scoresRaw, [-1, SEQ_LEN]);
      const mask = tf.reshape(maskRaw, [-1, SEQ_LEN]);
      const boolMask = tf.cast(mask, 'bool');
      const hasAny = tf.any(boolMask, 1, true);
      const defaultMask = tf.oneHot(
        tf.cast(tf.zeros([hasAny.shape[0]], 'int32'), 'int32'),
        SEQ_LEN,
        1.0,
        0.0
      );
      const safeMask = tf.add(mask, tf.mul(defaultMask, tf.cast(tf.logicalNot(hasAny), 'float32')));
      return tf.softmax(
        tf.where(tf.cast(safeMask, 'bool'), scores, tf.fill(scores.shape, -1e9)),
        1
      );
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(MaskedSoftmax);

class NegationLayer extends tf.layers.Layer {
  static className = 'NegationLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return inputShape as tf.Shape;
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => tf.neg(Array.isArray(inputs) ? inputs[0] : inputs));
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(NegationLayer);

class AttentionPoolingLayer extends tf.layers.Layer {
  static className = 'AttentionPoolingLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shapes = inputShape as [number[], number[]];
    return [shapes[1][0], shapes[1][2]];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [weights, input] = inputs as [tf.Tensor, tf.Tensor];
      return tf.sum(tf.mul(weights, input), 1);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(AttentionPoolingLayer);

class LastStepLayer extends tf.layers.Layer {
  static className = 'LastStepLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape =
      Array.isArray(inputShape) && Array.isArray(inputShape[0])
        ? (inputShape[0] as number[])
        : (inputShape as number[]);
    return [shape[0] ?? null, shape[2] ?? FEAT_DIM];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const seq = Array.isArray(inputs) ? inputs[0] : inputs;
      return (seq as tf.Tensor).slice([0, SEQ_LEN - 1, 0], [-1, 1, -1]).squeeze([1]);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(LastStepLayer);

class RecapLayer extends tf.layers.Layer {
  static className = 'RecapLayer';
  private a: tf.Tensor;
  private c: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    this.a = tf.tensor1d(
      stats.deltaStd.map((std, i) => std / Math.max(stats.recapStd[i] ?? 1, 1e-6))
    );
    this.c = tf.tensor1d(
      stats.deltaMean.map((mean, i) => mean / Math.max(stats.recapStd[i] ?? 1, 1e-6))
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [delta, base] = inputs as [tf.Tensor, tf.Tensor];
      return tf.add(tf.add(tf.mul(delta, this.a), base), this.c);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(RecapLayer);

class CategoryLayer extends tf.layers.Layer {
  static className = 'CategoryLayer';
  private catA: tf.Tensor;
  private catC: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    const m = [
      [1, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0.5, 0.5, 0.5, 0, 0, 0],
      [0, 0, 0, 0, 0, 0.5, 0.5, 0.5],
    ];
    this.catA = tf
      .tensor2d(
        m.map((row, i) =>
          row.map(
            (v, j) => (v * (stats.recapStd[j] ?? 1)) / Math.max(stats.categoryStd[i] ?? 1, 1e-6)
          )
        )
      )
      .transpose();
    this.catC = tf.tensor1d(
      m.map((row, i) => {
        const pts = row.reduce((acc, v, j) => acc + v * (stats.recapMean[j] ?? 0), 0);
        return (pts - (stats.categoryMean[i] ?? 0)) / Math.max(stats.categoryStd[i] ?? 1, 1e-6);
      })
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = inputShape as number[];
    return [shape[0], CATEGORY_DIM];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    const recap = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() =>
      tf.add(tf.matMul(recap.rank === 1 ? recap.expandDims(0) : recap, this.catA), this.catC)
    );
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(CategoryLayer);

class TotalLayer extends tf.layers.Layer {
  static className = 'TotalLayer';
  private totalA: tf.Tensor;
  private totalC: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    this.totalA = tf.tensor1d(stats.categoryStd.map((std) => std / Math.max(stats.totalStd, 1e-6)));
    this.totalC = tf.scalar(
      (stats.categoryMean.reduce((a, b) => a + b, 0) - stats.totalMean) /
        Math.max(stats.totalStd, 1e-6)
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = Array.isArray(inputShape[0]) ? inputShape[0] : (inputShape as number[]);
    return [shape[0], TOTAL_DIM];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    const cat = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() =>
      tf.add(
        tf.sum(tf.mul(cat.rank === 1 ? cat.expandDims(0) : cat, this.totalA), 1, true),
        this.totalC
      )
    );
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(TotalLayer);

class LambdaScale extends tf.layers.Layer {
  static className = 'LambdaScale';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [tensor, scale] = inputs as [tf.Tensor, tf.Tensor];
      return tf.mul(tensor, scale);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(LambdaScale);

const norm = (value: number, mean: number, std: number) => (value - mean) / Math.max(std, 1e-6);
const denorm = (value: number, mean: number, std: number) => value * Math.max(std, 1e-6) + mean;

const normalizeSequence = (sequence: number[][]) => {
  const out = sequence.slice(-SEQ_LEN).map((step) => {
    const copy = new Array(FEAT_DIM).fill(0);
    for (let i = 0; i < Math.min(step.length, FEAT_DIM); i++) copy[i] = step[i] ?? 0;
    return copy;
  });
  while (out.length < SEQ_LEN) out.unshift(new Array(FEAT_DIM).fill(0));
  return out;
};

const inferMask = (sequence: number[][], mask?: Array<boolean | number>) => {
  if (mask) {
    const out = mask.slice(-SEQ_LEN).map((value) => (value === true || value === 1 ? 1 : 0));
    while (out.length < SEQ_LEN) out.unshift(0);
    return out;
  }
  return sequence.map((step) => (step.some((value) => value !== 0) ? 1 : 0));
};

type V9VocabSizes = {
  judge: number;
  corps: number;
  show: number;
};

const clipEmbeddingId = (value: number | undefined, vocabSize: number, fallback = 0) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0 || id >= vocabSize) return fallback;
  return id;
};

export class V9SubcaptionModel {
  constructor(
    private model: tf.LayersModel,
    private stats: TargetStats,
    public modelDir: string,
    private staticDim = DEFAULT_TOTAL_STATIC_DIM,
    private vocabSizes: V9VocabSizes = { judge: 1, corps: 1, show: 1 }
  ) {}

  get staticFeatureDim() {
    return this.staticDim;
  }

  predictOne(input: V9PredictionInput): V9Prediction {
    const sequence = normalizeSequence(input.sequence);
    const mask = inferMask(sequence, input.sequenceMask);
    const lastValidIdx = mask.lastIndexOf(1);
    const fallbackBaseline = CAPTIONS.map((_, idx) => this.stats.recapMean[idx] ?? 15);
    const baselineRaw = input.baselineRecap
      ? [...input.baselineRecap]
      : lastValidIdx >= 0
        ? CAPTIONS.map(
            (_, idx) =>
              (sequence[lastValidIdx]?.[RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE + 2] ?? 0) *
              CAPTION_SCORE_SCALE
          )
        : fallbackBaseline;
    const baselineNorm = baselineRaw.map((value, idx) =>
      norm(
        Number.isFinite(value) ? value : fallbackBaseline[idx]!,
        this.stats.recapMean[idx]!,
        this.stats.recapStd[idx]!
      )
    );

    if (lastValidIdx >= 0) {
      const step = [...sequence[lastValidIdx]!];
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        const base = RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) step[base + j] = 0;
      }
      sequence[lastValidIdx] = step;
    }

    const staticFeatures = new Array(this.staticDim).fill(0);
    for (let i = 0; i < Math.min(input.staticFeatures.length, this.staticDim); i++)
      staticFeatures[i] = input.staticFeatures[i] ?? 0;
    const judges = new Array(CAPTION_COUNT).fill(0);
    for (let i = 0; i < Math.min(input.judgeIndices?.length ?? 0, CAPTION_COUNT); i++) {
      judges[i] = clipEmbeddingId(input.judgeIndices![i], this.vocabSizes.judge);
    }
    const corpsId = clipEmbeddingId(
      input.corpsId ?? UNK_CORPS_ID,
      this.vocabSizes.corps,
      UNK_CORPS_ID
    );
    const agnosticShowId = clipEmbeddingId(input.agnosticShowId ?? 0, this.vocabSizes.show, 0);
    const inferredHistoryLen = Math.max(0, mask.reduce<number>((sum, value) => sum + value, 0) - 1);
    const historyLen = Number.isFinite(input.historyLen)
      ? Math.max(0, Math.min(SEQ_LEN - 1, Number(input.historyLen)))
      : inferredHistoryLen;

    const tensors = {
      sequence: tf.tensor3d([sequence], [1, SEQ_LEN, FEAT_DIM], 'float32'),
      static: tf.tensor2d([staticFeatures], [1, this.staticDim], 'float32'),
      mask: tf.tensor2d([mask], [1, SEQ_LEN], 'float32'),
      judge_ids: tf.tensor2d([judges], [1, CAPTION_COUNT], 'int32'),
      corps_id: tf.tensor2d([[corpsId]], [1, 1], 'int32'),
      baseline_recap: tf.tensor2d([baselineNorm], [1, CAPTION_COUNT], 'float32'),
      history_len: tf.tensor2d([[historyLen]], [1, 1], 'float32'),
      judge_bias_scale: tf.tensor2d([[input.judgeBiasScale ?? 0]], [1, 1], 'float32'),
      corps_scale: tf.tensor2d([[input.corpsScale ?? 1]], [1, 1], 'float32'),
      agnostic_show_id: tf.tensor2d([[agnosticShowId]], [1, 1], 'int32'),
    };

    const output = this.model.predict([
      tensors.sequence,
      tensors.static,
      tensors.mask,
      tensors.judge_ids,
      tensors.corps_id,
      tensors.baseline_recap,
      tensors.history_len,
      tensors.judge_bias_scale,
      tensors.corps_scale,
      tensors.agnostic_show_id,
    ]) as tf.Tensor;
    const row = output.arraySync() as number[][];

    Object.values(tensors).forEach((tensor) => tensor.dispose());
    output.dispose();

    const values = row[0]!;
    const captions = {} as V9Prediction["captions"];
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      captions[CAPTIONS[idx]!] = {
        p10:
          denorm(values[idx]!, this.stats.deltaMean[idx]!, this.stats.deltaStd[idx]!) +
          baselineRaw[idx]!,
        p50:
          denorm(
            values[CAPTION_COUNT + idx]!,
            this.stats.deltaMean[idx]!,
            this.stats.deltaStd[idx]!
          ) + baselineRaw[idx]!,
        p90:
          denorm(
            values[CAPTION_COUNT * 2 + idx]!,
            this.stats.deltaMean[idx]!,
            this.stats.deltaStd[idx]!
          ) + baselineRaw[idx]!,
      };
      captions[CAPTIONS[idx]!]!.residualP50 = captions[CAPTIONS[idx]!]!.p50;
    }

    const recapStart = DELTA_DIM;
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      captions[CAPTIONS[idx]!]!.p50 = denorm(
        values[recapStart + idx]!,
        this.stats.recapMean[idx]!,
        this.stats.recapStd[idx]!
      );
    }

    const categoryStart = DELTA_DIM + RECAP_DIM;
    const categories = {
      ge: denorm(values[categoryStart]!, this.stats.categoryMean[0]!, this.stats.categoryStd[0]!),
      visual: denorm(
        values[categoryStart + 1]!,
        this.stats.categoryMean[1]!,
        this.stats.categoryStd[1]!
      ),
      music: denorm(
        values[categoryStart + 2]!,
        this.stats.categoryMean[2]!,
        this.stats.categoryStd[2]!
      ),
    };
    const total = denorm(
      values[categoryStart + CATEGORY_DIM]!,
      this.stats.totalMean,
      this.stats.totalStd
    );

    return { captions, categories, total };
  }

  dispose() {
    this.model.dispose();
  }
}

export type V9SubcaptionCheckpoint =
  | 'auto'
  | 'final'
  | 'best_composite'
  | 'best_total'
  | 'best'
  | 'best_loss'
  | 'best_phase_a'
  | 'best_phase_b'
  | 'best_phase_c';

export type LoadV9SubcaptionModelOptions = {
  checkpoint?: V9SubcaptionCheckpoint;
  statsPath?: string;
  stats?: TargetStats;
};

const resolveModelDir = (modelDir: string, checkpoint: V9SubcaptionCheckpoint = 'auto') => {
  const root = path.resolve(modelDir);
  if (checkpoint !== 'auto' && checkpoint !== 'final') {
    const checkpointDir = path.join(root, checkpoint);
    if (!fs.existsSync(path.join(checkpointDir, 'model.json'))) {
      throw new Error(`Missing ${checkpoint}/model.json under ${root}`);
    }
    return checkpointDir;
  }

  if (fs.existsSync(path.join(root, 'model.json'))) return root;
  if (checkpoint === 'final') throw new Error(`Missing model.json under ${root}`);

  for (const candidate of [
    'best_composite',
    'best_total',
    'best',
    'best_loss',
    'best_phase_b',
    'best_phase_c',
    'best_phase_a',
  ]) {
    const candidateDir = path.join(root, candidate);
    if (fs.existsSync(path.join(candidateDir, 'model.json'))) return candidateDir;
  }
  throw new Error(`No V9 subcaption model.json found under ${root}`);
};

const resolveStatsPath = (modelDir: string, explicitStatsPath?: string) => {
  const candidates = [
    explicitStatsPath ? path.resolve(explicitStatsPath) : null,
    path.join(modelDir, 'v9-subcaption-target-norm.json'),
    path.join(modelDir, 'target-norm.json'),
    path.resolve('results', 'v9-subcaption-target-norm.json'),
    path.resolve(path.dirname(modelDir), '..', '..', 'results', 'v9-subcaption-target-norm.json'),
  ].filter((value): value is string => Boolean(value));

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Missing V9 subcaption target normalization stats. Checked: ${candidates.join(', ')}`
    );
  }
  return found;
};

const embeddingInputDim = (model: tf.LayersModel, layerName: string) => {
  const layer = model.layers.find((candidate) => candidate.name === layerName);
  const config = layer?.getConfig() as { inputDim?: number } | undefined;
  const inputDim = Number(config?.inputDim);
  return Number.isFinite(inputDim) && inputDim > 0 ? inputDim : 1;
};

const loadLocalLayersModel = async (modelJsonPath: string) => {
  const modelDir = path.dirname(modelJsonPath);
  const artifacts = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));
  const weightData = Buffer.concat(
    (artifacts.weightsManifest ?? [])
      .flatMap((group: { paths?: string[] }) => group.paths ?? [])
      .map((weightPath: string) => fs.readFileSync(path.resolve(modelDir, weightPath)))
  );

  return tf.loadLayersModel({
    load: async () => ({
      modelTopology: artifacts.modelTopology,
      format: artifacts.format,
      generatedBy: artifacts.generatedBy,
      convertedBy: artifacts.convertedBy,
      weightSpecs: (artifacts.weightsManifest ?? []).flatMap(
        (group: { weights?: tf.io.WeightsManifestEntry[] }) => group.weights ?? []
      ),
      weightData: weightData.buffer.slice(
        weightData.byteOffset,
        weightData.byteOffset + weightData.byteLength
      ),
    }),
  });
};

export async function loadV9SubcaptionModel(
  modelDir: string,
  options: LoadV9SubcaptionModelOptions = {}
) {
  const resolvedModelDir = resolveModelDir(modelDir, options.checkpoint ?? 'auto');
  const stats = options.stats ?? JSON.parse(
    fs.readFileSync(resolveStatsPath(resolvedModelDir, options.statsPath), 'utf-8')
  ) as TargetStats;
  (globalThis as any).V9_SUBCAPTION_INFERENCE_STATS = stats;
  await tf.setBackend('cpu');
  const model = await loadLocalLayersModel(path.resolve(resolvedModelDir, 'model.json'));
  const staticInput = model.inputs.find((input) => input.name.startsWith('static'));
  const staticDim = Number(staticInput?.shape?.[1] ?? DEFAULT_TOTAL_STATIC_DIM);
  const vocabSizes = {
    judge: embeddingInputDim(model, 'judge_embedding'),
    corps: embeddingInputDim(model, 'corps_embedding'),
    show: embeddingInputDim(model, 'agnostic_show_embedding'),
  };
  return new V9SubcaptionModel(model, stats, resolvedModelDir, staticDim, vocabSizes);
}
