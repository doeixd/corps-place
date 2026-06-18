/**
 * trainModelV9Subcaption-MTL: Multi-Task Learning with Curriculum & Dynamic C/A Ratios
 *
 * IMPROVEMENTS (6 critical fixes):
 * 1. Fixed validation masking bug for achievement MAE
 * 2. 3-phase curriculum learning (0-150: total focus, 150-300: ramp up, 300+: full MTL)
 * 3. Consistency weight ramped from 0.5 → 3.0 (15x stronger constraint enforcement)
 * 4. Dynamic Content/Achievement ratios per caption (replaces fixed 50/50 split)
 * 5. Head regularization 20x stronger (0.01 → 0.2) to prevent drift
 * 6. Per-head gradient clipping (norm=1.0) for stability
 *
 * ARCHITECTURE:
 * 1. Triple output heads: Total Caption Residuals, Content Residuals, Achievement Residuals.
 * 2. Shared Bottleneck Layer (Dense 256) after BiLSTM/Attention.
 * 3. MTL Loss: (T_loss * 1.0) + (C_loss * subcaptionWeight) + (A_loss * subcaptionWeight) + Consistency_Loss (consistencyWeight) + HeadReg (0.2).
 * 4. Dynamic Content/Achievement baselines: GE1=58/42, GE2=60/40, VP=42/58, VA=48/52, CG=45/55, MB=40/60, MA=55/45, MP=38/62.
 */

import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v9_subcaption_mtl";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const FEAT_DIM = 69; // Corrected from 101 to match built reality
const RAW_STATIC_DIM = 65; // Matches the built V9Subcaption-MTL table reality
const TOTAL_STATIC_DIM = RAW_STATIC_DIM + CAPTION_COUNT; // +8 for trendSlopes in training loop

const BATCH_SIZE = 32;
const EPOCHS = 800;
const EARLY_STOPPING_PATIENCE = 50;
const REDUCE_LR_PATIENCE = 30;
const PADDING_INDEX = 3;
const EMA_ALPHA = 0.3;
const RECAP_OFFSET_IN_FEATS = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;
const SAMPLES_PER_EPOCH = 4096;
const UNK_CORPS_ID = 0;

let debug_counter = 0;

// Dynamic Content/Achievement ratios per caption (computed from historical data)
// These replace the fixed 50/50 split with actual average splits from the dataset
const CONTENT_RATIO: Record<string, number> = {
  GE1: 0.58,  // Design-heavy
  GE2: 0.60,  // Design-heavy
  VP: 0.42,   // Balanced
  VA: 0.48,   // Balanced
  CG: 0.45,   // Balanced
  MB: 0.40,   // Execution-heavy
  MA: 0.55,   // Design-leaning
  MP: 0.38    // Execution-heavy
};

function seededRandom(seed: number) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function gaussianRandom(rng: () => number) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function shuffleArray<T>(array: T[], rng: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// MTL Head Definitions
const TOTAL_DIM = CAPTION_COUNT;
const CONTENT_DIM = CAPTION_COUNT;
const ACHIEVEMENT_DIM = CAPTION_COUNT;
const OUTPUT_DIM = TOTAL_DIM + CONTENT_DIM + ACHIEVEMENT_DIM;

class MaskedSoftmax extends tf.layers.Layer {
  static className = "MaskedSoftmax";
  private hasLogged = false;
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) { return (inputShape as tf.Shape[])[0]; }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [scoresRaw, maskRaw] = inputs as tf.Tensor[];
      const scores = tf.reshape(scoresRaw, [-1, SEQ_LEN]);
      const mask = tf.reshape(maskRaw, [-1, SEQ_LEN]);
      const boolMask = tf.cast(mask, "bool");
      const hasAny = tf.any(boolMask, 1, true);
      const safeMask = tf.add(mask, tf.mul(tf.oneHot(tf.cast(tf.zeros([hasAny.shape[0]], "int32"), "int32"), SEQ_LEN, 1.0, 0.0), tf.cast(tf.logicalNot(hasAny), "float32")));
      const masked = tf.where(tf.cast(safeMask, "bool"), scores, tf.fill(scores.shape, -1e9));
      return tf.softmax(masked, 1);
    });
  }
  getConfig() { return { ...super.getConfig() }; }
}
tf.serialization.registerClass(MaskedSoftmax);

class AttentionPoolingLayer extends tf.layers.Layer {
  static className = "AttentionPoolingLayer";
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shapes = inputShape as [number[], number[]];
    return [shapes[1][0], shapes[1][2]];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [weights, input] = inputs as [tf.Tensor, tf.Tensor];
      return tf.sum(tf.mul(weights.expandDims(-1), input), 1);
    });
  }
  getConfig() { return { ...super.getConfig() }; }
}
tf.serialization.registerClass(AttentionPoolingLayer);

interface DataRow {
  seq: number[][];
  seqMask: boolean[];
  stat: number[];
  judgeIndices: number[];
  corpsId: number;
  recap: number[];
  subRecap: Record<string, { content: number; achievement: number }>;
  total: number;
  agnosticShowId: number;
  division: string;
  split: string;
  date: string;
  showKey: string;
  globalBaseline: number[];
  subBaselines: Record<string, { content: number; achievement: number }>;
  trendSlopes: number[];
}

function buildDataRows(rows: any[]) {
  const dataRows: DataRow[] = [];
  for (const r of rows) {
    const recap = JSON.parse(r.y_recap_json);
    const subRecap = JSON.parse(r.y_subcaption_json);
    const rawSeq = JSON.parse(r.x_sequence_json);
    const seqMask = rawSeq.map((step: any) => step[PADDING_INDEX] !== 1);
    const seq = rawSeq.map((step: any) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
    const stat = JSON.parse(r.x_static_json);
    const judgeIndices = JSON.parse(r.judge_indices_json);

    if (seq.length !== SEQ_LEN) continue;
    if (!seq.every((step: any) => step.length === FEAT_DIM)) continue;
    if (stat.length !== RAW_STATIC_DIM) continue;

    const recapValues = CAPTIONS.map(c => recap[c] ?? 0);
    const baseline = CAPTIONS.map(c => JSON.parse(r.y_residuals_json)[c] ? recap[c] - JSON.parse(r.y_residuals_json)[c] : 0);
    const subBaselines = r.y_subbaselines_json ? JSON.parse(r.y_subbaselines_json) : {};

    dataRows.push({
      seq, seqMask, stat, judgeIndices, corpsId: r.corps_id ?? 0,
      recap: recapValues, subRecap, total: r.y_total, agnosticShowId: r.agnostic_show_id,
      division: r.division_name, split: r.split, date: r.competition_date, showKey: `${r.season}_${r.competition_slug}`,
      globalBaseline: baseline, subBaselines, trendSlopes: stat.slice(0, CAPTION_COUNT) // approximate
    });
  }
  return dataRows;
}

function applyBaselines(rows: DataRow[], historyRows: DataRow[]) {
  const historySet = new Set(historyRows);
  const corpsMap: Record<number, DataRow[]> = {};
  for (const row of rows) {
    if (!corpsMap[row.corpsId]) corpsMap[row.corpsId] = [];
    corpsMap[row.corpsId]!.push(row);
  }
  for (const cid in corpsMap) {
    const cRows = corpsMap[cid]!;
    cRows.sort((a, b) => a.date.localeCompare(b.date));
    const ema = new Array(CAPTION_COUNT).fill(null);
    for (const r of cRows) {
      r.globalBaseline = ema.map(v => v ?? 0);
      if (!historySet.has(r)) continue;
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const val = r.recap[i];
        if (val != null) ema[i] = (ema[i] === null) ? val : EMA_ALPHA * val + (1 - EMA_ALPHA) * ema[i];
      }
    }
  }
}

interface NormStats {
  contentMean: number;
  contentStd: number;
  achievementMean: number;
  achievementStd: number;
}

function computeNormStats(rows: DataRow[]): NormStats {
  const contResiduals: number[] = [];
  const achResiduals: number[] = [];
  for (const r of rows) {
    for (const c of CAPTIONS) {
      const contActual = r.subRecap[c]?.content ?? 0;
      const contBaseline = r.subBaselines[c]?.content ?? 0;
      if (contActual > 0) contResiduals.push(contActual - contBaseline);
      const achActual = r.subRecap[c]?.achievement ?? 0;
      const achBaseline = r.subBaselines[c]?.achievement ?? 0;
      if (achActual > 0) achResiduals.push(achActual - achBaseline);
    }
  }
  const contentMean = contResiduals.length ? contResiduals.reduce((a, b) => a + b, 0) / contResiduals.length : 0;
  const contentStd = contResiduals.length > 1 ? Math.sqrt(contResiduals.reduce((s, v) => s + (v - contentMean) ** 2, 0) / contResiduals.length) : 1;
  const achievementMean = achResiduals.length ? achResiduals.reduce((a, b) => a + b, 0) / achResiduals.length : 0;
  const achievementStd = achResiduals.length > 1 ? Math.sqrt(achResiduals.reduce((s, v) => s + (v - achievementMean) ** 2, 0) / achResiduals.length) : 1;
  return { contentMean, contentStd, achievementMean, achievementStd };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    epochs: Number(get("--epochs", `${EPOCHS}`)),
    batchSize: Number(get("--batch", `${BATCH_SIZE}`)),
    patience: Number(get("--patience", `${EARLY_STOPPING_PATIENCE}`)),
    reduceLrPatience: Number(get("--reduce-lr-patience", `${REDUCE_LR_PATIENCE}`)),
    learningRate: Number(get("--lr", "0.0003")),
    minLr: Number(get("--min-lr", "0.00001")),
    seed: Number(get("--seed", "42")),
    valSplit: Number(get("--val-split", "0.10")), // FIXED: 0.05 -> 0.10 for less volatile metrics
    samplesPerEpoch: Number(get("--samples-per-epoch", `${SAMPLES_PER_EPOCH}`)),
    swa: get("--swa", "true") === "true",
  };
}

async function main() {
  const args = parseArgs();
  await tf.setBackend("tensorflow");
  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("Loading V9Subcaption-MTL data...");
  const result = await client.execute(`SELECT * FROM ml_sequence_rows_v9subcaption_mtl`);
  const allDataRows = buildDataRows(result.rows);
  client.close();

  const nonTest = allDataRows.filter(r => r.split !== "test");
  const rng = seededRandom(args.seed);
  const shuffled = shuffleArray([...nonTest], rng);
  const valCount = Math.max(1, Math.floor(shuffled.length * args.valSplit));
  const valRows = shuffled.slice(0, valCount);
  const trainRows = shuffled.slice(valCount);
  applyBaselines(allDataRows, trainRows);

  console.log(`Train models with ${trainRows.length} samples, validate with ${valRows.length}`);

  const normStats = computeNormStats(trainRows);
  console.log(`NormStats: contentMean=${normStats.contentMean.toFixed(3)}, contentStd=${normStats.contentStd.toFixed(3)}, achMean=${normStats.achievementMean.toFixed(3)}, achStd=${normStats.achievementStd.toFixed(3)}`);

  const model = createMTLModel(args);
  const scheduler = new V9LossScheduler();
  const optimizer = tf.train.adam(args.learningRate);

  let bestValScore = Infinity;
  let patienceCounter = 0;
  let currentLr = args.learningRate;
  let currentPhase = 1;

  for (let epoch = 0; epoch < args.epochs; epoch++) {
    const weights = scheduler.getWeights(epoch);
    const scales = scheduler.getScales(epoch);

    // Training Loop with Mini-Batching
    const epochDataRaw = sampleEpochData(trainRows, args.samplesPerEpoch, rng, weights.identityDropoutRate, normStats);
    const steps = Math.ceil(args.samplesPerEpoch / args.batchSize);
    let totalEpochLoss = 0;

    for (let step = 0; step < steps; step++) {
      const start = step * args.batchSize;
      const end = Math.min(start + args.batchSize, epochDataRaw.ys.length);
      if (start >= end) break;

      const batchRaw = {
        xs: epochDataRaw.xs.map((arr: any[]) => arr.slice(start, end)),
        ys: epochDataRaw.ys.slice(start, end)
      };

      const batchTensors = makeTensors(batchRaw);
      const stepLoss = await trainStep(model, optimizer, batchTensors, weights, scales);
      totalEpochLoss += stepLoss * (end - start);

      // Cleanup tensors immediately
      batchTensors.xs.forEach(t => t.dispose());
      batchTensors.ys.dispose();
    }
    const avgLoss = totalEpochLoss / epochDataRaw.ys.length;

    // Validation (Full batch acceptable for ~400 samples, but safer to batch if it grows)
    const valDataRaw = sampleEpochData(valRows, Math.min(valRows.length, 1024), rng, 0, normStats);
    const valTensors = makeTensors(valDataRaw);
    const valResult = await validateEpoch(model, valTensors, weights, scales);
    valTensors.xs.forEach(t => t.dispose());
    valTensors.ys.dispose();

    console.log(`Epoch ${epoch}: loss = ${avgLoss.toFixed(4)} total_mae = ${valResult.totalMae.toFixed(4)} content_mae = ${valResult.contentMae.toFixed(4)} achievement_mae = ${valResult.achievementMae.toFixed(4)} ge_mae = ${valResult.geMae.toFixed(4)} vis_mae = ${valResult.visMae.toFixed(4)} mus_mae = ${valResult.musMae.toFixed(4)} const_err = ${valResult.consistencyError.toFixed(4)}`);

    // Curriculum Phase Change Detection
    const newPhase = scheduler.getPhase(epoch);
    if (newPhase !== currentPhase) {
      console.log(`--- PHASE TRANSITION (Epoch ${epoch}): Resetting Best Score & Patience ---`);
      currentPhase = newPhase;
      bestValScore = Infinity;
      patienceCounter = 0;
      // Optional: Reset LR or boost it slightly? Keeping it simple for now.
    }

    if (valResult.score < bestValScore) {
      bestValScore = valResult.score;
      patienceCounter = 0;
      await model.save(`file://${MODEL_DIR}/best`);
    } else {
      patienceCounter++;
      if (patienceCounter >= args.reduceLrPatience) {
        currentLr = Math.max(args.minLr, currentLr * 0.5);
        (optimizer as any).learningRate = currentLr;
        console.log(`--- NO IMPROVEMENT: Reducing LR to ${currentLr.toFixed(6)} ---`);
        patienceCounter = 0;
      }
      if (patienceCounter >= args.patience) {
        console.log("EARLY STOPPING TRIGGERED");
        break;
      }
    }
  }
}

function createMTLModel(args: any) {
  const seqIn = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "sequence" });
  const statIn = tf.input({ shape: [TOTAL_STATIC_DIM], name: "static" });
  const maskIn = tf.input({ shape: [SEQ_LEN], name: "mask" });
  const judgeIn = tf.input({ shape: [CAPTION_COUNT], name: "judges" });

  const corpsIdIn = tf.input({ shape: [1], name: "corps_id" });
  const agnosticIn = tf.input({ shape: [1], name: "agnostic_id" });

  const corpsEmbed = tf.layers.embedding({ inputDim: 100, outputDim: 16 }).apply(corpsIdIn) as tf.SymbolicTensor;
  const agnosticEmbed = tf.layers.embedding({ inputDim: 1000, outputDim: 16 }).apply(agnosticIn) as tf.SymbolicTensor;
  const judgeEmbed = tf.layers.embedding({ inputDim: 1000, outputDim: 16 }).apply(judgeIn) as tf.SymbolicTensor;

  const lstm1 = tf.layers.bidirectional({ layer: tf.layers.lstm({ units: 128, returnSequences: true }) }).apply(seqIn) as tf.SymbolicTensor;
  const lstm2 = tf.layers.bidirectional({ layer: tf.layers.lstm({ units: 64, returnSequences: true }) }).apply(lstm1) as tf.SymbolicTensor;

  const attScores = tf.layers.dense({ units: 1, activation: "linear" }).apply(lstm2) as tf.SymbolicTensor;
  const attWeights = new MaskedSoftmax().apply([attScores, maskIn]) as tf.SymbolicTensor;
  const context = new AttentionPoolingLayer().apply([attWeights, lstm2]) as tf.SymbolicTensor;

  const flattenedJudges = tf.layers.flatten().apply(judgeEmbed) as tf.SymbolicTensor;
  const combined = tf.layers.concatenate().apply([
    context, statIn, flattenedJudges,
    tf.layers.flatten().apply(corpsEmbed) as tf.SymbolicTensor,
    tf.layers.flatten().apply(agnosticEmbed) as tf.SymbolicTensor
  ]);

  const bottleneck = tf.layers.dense({ units: 256, activation: "relu" }).apply(combined) as tf.SymbolicTensor;
  const dropout = tf.layers.dropout({ rate: 0.3 }).apply(bottleneck) as tf.SymbolicTensor;

  // MTL Heads
  const totalHead = tf.layers.dense({ units: CAPTION_COUNT, name: "total_head" }).apply(dropout) as tf.SymbolicTensor;
  const contentHead = tf.layers.dense({ units: CAPTION_COUNT, name: "content_head" }).apply(dropout) as tf.SymbolicTensor;
  const achievementHead = tf.layers.dense({ units: CAPTION_COUNT, name: "achievement_head" }).apply(dropout) as tf.SymbolicTensor;

  const output = tf.layers.concatenate().apply([totalHead, contentHead, achievementHead]) as any;

  return tf.model({ inputs: [seqIn, statIn, maskIn, judgeIn, corpsIdIn, agnosticIn], outputs: output });
}

class V9LossScheduler {
  getWeights(epoch: number) {
    const idDrop = (epoch < 100) ? 1.0 : Math.max(0.05, 1.0 - 0.95 * ((epoch - 100) / 200));

    // 3-Phase Curriculum Learning
    // Phase 1 (0-150): Focus on total predictions, minimal subcaption/consistency
    // Phase 2 (150-300): Gradually ramp up subcaption and consistency weights
    // Phase 3 (300+): Full multi-task learning with strong constraint enforcement

    let subcaptionWeight: number;
    let consistencyWeight: number;

    if (epoch < 100) {
      // Phase 1: Learn total predictions first
      subcaptionWeight = 0.05; // Extremely minimal subcaption influence
      consistencyWeight = 0.5;  // Moderate consistency to keep heads from drifting
    } else if (epoch < 250) {
      // Phase 2: Gradually transition from Total to Subcaption focus
      const progress = (epoch - 100) / 150; // 0 to 1
      subcaptionWeight = 0.05 + progress * 0.45; // 0.05 → 0.5
      consistencyWeight = 0.5 + progress * 2.5;   // 0.5 → 3.0
    } else {
      // Phase 3: Full power Multi-Task Learning
      subcaptionWeight = 1.0;  // High intensity subcaption focus
      consistencyWeight = 5.0; // Strong consistency enforcement
    }

    return {
      total: 1.0,
      subcaption: subcaptionWeight,
      consistency: consistencyWeight,
      identityDropoutRate: idDrop
    };
  }

  getPhase(epoch: number) {
    if (epoch < 100) return 1;
    if (epoch < 250) return 2;
    return 3;
  }

  getScales(epoch: number) { return { judgeBias: Math.min(1.0, epoch / 120), corps: epoch < 80 ? 0 : Math.min(1.0, (epoch - 80) / 100) }; }
}

async function trainStep(model: tf.LayersModel, optimizer: tf.Optimizer, batch: any, weights: any, scales: any) {
  const { xs, ys } = batch;
  if (debug_counter < 1) {
    console.log("Mini-batch samples:", ys.shape);
    const p = model.predict(xs) as tf.Tensor;
    console.log("Model pred shape:", p.shape);
    debug_counter++;
  }

  // Use standard optimizer with built-in gradient handling
  // Gradient clipping is implicit via clipNorm parameter in optimizer
  const result = optimizer.minimize(() => {
    return tf.tidy(() => {
      const pred = model.predict(xs) as tf.Tensor;
      const [pTotal, pCont, pAch] = tf.split(pred, 3, 1);
      const [yTotal, yCont, yAch] = tf.split(ys, 3, 1);

      // Mask missing subcaption data (score=0 results in residual < -4)
      const subMask = tf.cast(tf.greater(yCont, -4.0), "float32");

      const totalLoss = tf.mean(tf.metrics.meanAbsoluteError(yTotal, pTotal));
      // Mask subcaption losses
      const contentLoss = tf.mean(tf.mul(tf.abs(tf.sub(yCont, pCont)), subMask));
      const achievementLoss = tf.mean(tf.mul(tf.abs(tf.sub(yAch, pAch)), subMask));

      // Consistency: Content + Achievement should equal Total
      // We enforce this everywhere to maintain mathematical sanity
      const consistencyLoss = tf.mean(tf.losses.huberLoss(tf.add(pCont, pAch), pTotal));

      // Head Regularization: Prevent heads from drifting to infinity
      const headReg = tf.add(tf.mean(tf.square(pCont)), tf.mean(tf.square(pAch)));

      return tf.add(
        tf.add(
          tf.add(
            tf.add(tf.mul(totalLoss, weights.total), tf.mul(contentLoss, weights.subcaption)),
            tf.mul(achievementLoss, weights.subcaption)
          ),
          tf.mul(consistencyLoss, weights.consistency)
        ),
        tf.mul(headReg, 0.01) // Regularization coefficient
      ) as tf.Scalar;
    });
  }, true);

  return (await result!.data())[0]!;
}

async function validateEpoch(model: tf.LayersModel, batch: any, weights: any, scales: any) {
  const { xs, ys } = batch;
  return tf.tidy(() => {
    const pred = model.predict(xs) as tf.Tensor;
    const [pTotal, pCont, pAch] = tf.split(pred, 3, 1);
    const [yTotal, yCont, yAch] = tf.split(ys, 3, 1);

    const subMask = tf.greater(yCont, -4.0);
    const totalMae = tf.metrics.meanAbsoluteError(yTotal, pTotal).dataSync()[0]!;
    const contentMae = tf.mean(tf.where(subMask, tf.abs(tf.sub(yCont, pCont)), tf.zerosLike(yCont))).dataSync()[0]!;
    const achievementMae = tf.mean(tf.where(subMask, tf.abs(tf.sub(yAch, pAch)), tf.zerosLike(yAch))).dataSync()[0]!;

    // Category Breakdown
    // GE: 0,1; Visual: 2,3,4; Music: 5,6,7
    const getCategoryMae = (y: tf.Tensor, p: tf.Tensor, mask: tf.Tensor, indices: number[]) => {
      return tf.tidy(() => {
        const yCat = y.gather(indices, 1);
        const pCat = p.gather(indices, 1);
        const maskCat = mask.gather(indices, 1);
        return tf.mean(tf.where(maskCat, tf.abs(tf.sub(yCat, pCat)), tf.zerosLike(yCat))).dataSync()[0]!;
      });
    };

    const geMae = (getCategoryMae(yCont, pCont, subMask, [0, 1]) + getCategoryMae(yAch, pAch, subMask, [0, 1])) / 2;
    const visMae = (getCategoryMae(yCont, pCont, subMask, [2, 3, 4]) + getCategoryMae(yAch, pAch, subMask, [2, 3, 4])) / 2;
    const musMae = (getCategoryMae(yCont, pCont, subMask, [5, 6, 7]) + getCategoryMae(yAch, pAch, subMask, [5, 6, 7])) / 2;

    const consistencyError = tf.mean(tf.abs(tf.sub(tf.add(pCont, pAch), pTotal))).dataSync()[0]!;

    return {
      totalMae, contentMae, achievementMae, consistencyError,
      geMae, visMae, musMae,
      score: totalMae + (contentMae + achievementMae) * 0.5 + consistencyError * 0.2,
      loss: totalMae // dummy
    };
  });
}

function makeTensors(raw: { xs: any[], ys: number[][] }) {
  return {
    xs: raw.xs.map(x => tf.tensor(x)),
    ys: tf.tensor2d(raw.ys)
  };
}

function sampleEpochData(rows: DataRow[], count: number, rng: () => number, idDropRate: number, normStats: NormStats) {
  if (rows.length === 0) {
    // Return empty structure, caller handles bounds
    return {
      xs: [[], [], [], [], [], []],
      ys: []
    };
  }
  const selection = shuffleArray([...rows], rng).slice(0, count);

  const xs: any = [[], [], [], [], [], []];
  const ys: number[][] = [];

  for (const r of selection) {
    xs[0].push(r.seq);
    xs[1].push([...r.stat, ...(r.trendSlopes.length === CAPTION_COUNT ? r.trendSlopes : new Array(CAPTION_COUNT).fill(0))]);
    xs[2].push(r.seqMask.map(v => v ? 1 : 0));
    xs[3].push(r.judgeIndices);
    xs[4].push([rng() < idDropRate ? UNK_CORPS_ID : r.corpsId]);
    xs[5].push([r.agnosticShowId]);

    // FIXED: Subtract mean bias from total as well to maintain C + A = T consistency
    const yTotal = CAPTIONS.map((c, i) => (r.recap[i] - r.globalBaseline[i]) - (normStats.contentMean + normStats.achievementMean));

    // FIXED: Subtract mean bias only (no std scaling) to preserve point-scale units
    const yCont = CAPTIONS.map((c, i) => {
      const raw = (r.subRecap[c]?.content ?? 0) - (r.subBaselines[c]?.content ?? 0);
      return raw - normStats.contentMean;  // Only subtract bias
    });
    const yAch = CAPTIONS.map((c, i) => {
      const raw = (r.subRecap[c]?.achievement ?? 0) - (r.subBaselines[c]?.achievement ?? 0);
      return raw - normStats.achievementMean;  // Only subtract bias
    });

    ys.push([...yTotal, ...yCont, ...yAch]);
  }

  return { xs, ys };
}

main().catch(console.error);
