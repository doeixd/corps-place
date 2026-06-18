// src/training/trainModelV3.ts
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// ----- Constants -----

const TARGET_CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
const NUM_QUANTILES = 3; // P10, P50, P90
const QUANTILES = [0.1, 0.5, 0.9];
const SEQ_LEN = 15;
const FEAT_DIM = 14;

// ----- Types -----

interface RawSequenceRow {
  row_id: number;
  corps_id: number;
  season_id: number;
  division_id: number;
  x_sequence_json: string;
  y_recap_json: string;
  split: string;
}

interface Dataset {
  xSequence: number[][][];
  xContext: number[][]; // [season, corps, division]
  yRecap: number[][];
  weight: number[];
}

// ----- Data Loading -----

function loadDataset(db: Database, split: string): Dataset {
  const rows = db.prepare(`
    SELECT corps_id, x_sequence_json, y_recap_json, split 
    FROM ml_sequence_rows_v3
    WHERE split = ?
  `).all(split) as any[];

  const ds: Dataset = { xSequence: [], xContext: [], yRecap: [], weight: [] };

  for (const r of rows) {
    const seq = JSON.parse(r.x_sequence_json);
    const recapMap = JSON.parse(r.y_recap_json);

    // Normalize recap to vector
    const yVec = TARGET_CAPTIONS.map(c => recapMap[c] ?? 0);
    if (yVec.every(v => v === 0)) continue;

    ds.xSequence.push(seq);
    ds.xContext.push([0, r.corps_id, 0]); // Simplification: season/div id 0 for now
    ds.yRecap.push(yVec);
    ds.weight.push(1.0);
  }

  return ds;
}

// ----- Model Build -----

function buildModelV3(cfg: {
  corpsVocab: number;
  l2: number;
  dropout: number;
  lstmUnits: number;
}): tf.LayersModel {
  const reg = tf.regularizers.l2({ l2: cfg.l2 });

  // Inputs
  const seqIn = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "x_sequence" });
  const contextIn = tf.input({ shape: [3], name: "x_context" }); // [season, corps, division]

  // Sequence Branch (LSTM)
  const lstm = tf.layers.lstm({
    units: cfg.lstmUnits,
    kernelRegularizer: reg,
    recurrentRegularizer: reg,
    name: "lstm_trajectory"
  }).apply(seqIn) as tf.SymbolicTensor;

  // Context Branch (Simplified for now - just corps embedding)
  // Extract corps_id from contextIn[:, 1]
  const corpsId = tf.layers.reshape({ targetShape: [1] }).apply(
    tf.layers.dense({ units: 1, useBias: false }).apply(contextIn) // dummy to allow split? No.
  ) as tf.SymbolicTensor;
  // Better: just pass corps_id as separate input
  const corpsIn = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });
  const corpsEmb = tf.layers.flatten().apply(
    tf.layers.embedding({ inputDim: cfg.corpsVocab, outputDim: 16, embeddingsRegularizer: reg }).apply(corpsIn)
  ) as tf.SymbolicTensor;

  // Fusion
  const merged = tf.layers.concatenate().apply([lstm, corpsEmb]) as tf.SymbolicTensor;
  const h1 = tf.layers.dense({ units: 128, activation: "relu", kernelRegularizer: reg }).apply(merged) as tf.SymbolicTensor;
  const d1 = tf.layers.dropout({ rate: cfg.dropout }).apply(h1) as tf.SymbolicTensor;
  const out = tf.layers.dense({ units: TARGET_CAPTIONS.length * NUM_QUANTILES, name: "y_quantiles" }).apply(d1) as tf.SymbolicTensor;

  return tf.model({ inputs: [seqIn, corpsIn], outputs: out });
}

// ----- Loss -----

function multiQuantileLoss(qs: number[], numCaptions: number) {
  // Tile quantiles for each caption: [q1,q2,q3,q1,q2,q3,...] for all captions
  const qTiled: number[] = [];
  for (let i = 0; i < numCaptions; i++) {
    qTiled.push(...qs);
  }
  const qT = tf.tensor1d(qTiled, "float32"); // Shape: [numCaptions * numQuantiles]

  return (yTrue: tf.Tensor, yPred: tf.Tensor) => tf.tidy(() => {
    // yTrue and yPred have shape [batch, numCaptions * numQuantiles]
    const e = tf.sub(yTrue, yPred); // [batch, 24]
    // qT broadcasts from [24] to [batch, 24]
    const loss = tf.maximum(tf.mul(qT, e), tf.mul(tf.sub(qT, 1), e));
    return tf.mean(loss);
  });
}

// ----- Progress Logger (show Finals predictions each epoch) -----

interface FinalsRow {
  corps_key: string;
  corps_id: number;
  x_sequence_json: string;
  y_recap_json: string;
}

class ProgressLogger extends tf.Callback {
  private finalsSeqTensor: tf.Tensor;
  private finalsCorpsTensor: tf.Tensor;
  private corpsNames: string[];

  constructor(db: Database) {

    super();

    // Load 2024 Finals data from ml_sequence_rows_v3
    const finalsRows = db.prepare(`
      SELECT s.corps_key, s.corps_id, s.x_sequence_json, s.y_recap_json
      FROM ml_sequence_rows_v3 s
      WHERE s.competition_slug = '2024-dci-world-championship-finals'
      ORDER BY json_extract(s.y_recap_json, '$.GE1') + json_extract(s.y_recap_json, '$.GE2') DESC
    `).all() as FinalsRow[];

    if (finalsRows.length === 0) {
      console.warn("No 2024 Finals data found in ml_sequence_rows_v3");
      this.corpsNames = [];
      this.finalsSeqTensor = tf.zeros([1, SEQ_LEN, FEAT_DIM]);
      this.finalsCorpsTensor = tf.zeros([1, 1], "int32");
      return;
    }

    // Get corps names from ml_corps_vocab
    const corpsNameMap: Record<string, string> = {};
    const vocabRows = db.prepare("SELECT corps_key, corps_id FROM ml_corps_vocab").all() as any[];
    for (const v of vocabRows) corpsNameMap[v.corps_key] = v.corps_key;

    this.corpsNames = finalsRows.map(r => r.corps_key);

    const sequences = finalsRows.map(r => JSON.parse(r.x_sequence_json));
    const corpsIds = finalsRows.map(r => [r.corps_id]);

    this.finalsSeqTensor = tf.tensor3d(sequences);
    this.finalsCorpsTensor = tf.tensor2d(corpsIds, [finalsRows.length, 1], "int32");

    console.log(`Finals preview enabled: ${finalsRows.length} corps`);
  }

  override async onEpochEnd(epoch: number, logs?: tf.Logs) {
    const loss = logs?.loss?.toFixed(4) ?? "???";
    const valLoss = logs?.val_loss?.toFixed(4) ?? "???";
    console.log(`Epoch ${epoch}: loss=${loss}, val_loss=${valLoss}`);

    if (this.corpsNames.length === 0) return;

    tf.tidy(() => {
      const preds = this.model!.predict([this.finalsSeqTensor, this.finalsCorpsTensor]) as tf.Tensor;
      const data = preds.arraySync() as number[][];

      const results = data.map((row, i) => {
        // Extract P50 predictions for each caption
        const captions: number[] = [];
        for (let c = 0; c < TARGET_CAPTIONS.length; c++) {
          captions.push(row[c * 3 + 1]!); // P50 is index 1 in each triplet
        }

        const ge = captions[0]! + captions[1]!;
        const viz = (captions[2]! + captions[3]! + captions[4]!) * 0.5;
        const mus = (captions[5]! + captions[6]! + captions[7]!) * 0.5;
        const tot = ge + viz + mus;

        return { name: this.corpsNames[i], ge, viz, mus, tot };
      });

      results.sort((a, b) => b.tot - a.tot);

      console.log(`\n--- Predicted 2024 Finals (Epoch ${epoch}) ---`);
      console.log("+------+---------------------------+-------+-------+-------+-------+");
      console.log("| Rank | Corps                     | GE    | Viz   | Music | Total |");
      console.log("+------+---------------------------+-------+-------+-------+-------+");
      results.forEach((r, idx) => {
        console.log(`| ${(idx + 1).toString().padEnd(4)} | ${r.name!.padEnd(25)} | ${r.ge.toFixed(2).padStart(5)} | ${r.viz.toFixed(2).padStart(5)} | ${r.mus.toFixed(2).padStart(5)} | ${r.tot.toFixed(2).padStart(5)} |`);
      });
      console.log("+------+---------------------------+-------+-------+-------+-------+\n");
    });
  }
}

// ----- Main Training -----

async function train() {
  const db = new Database("./dci-relational.db");

  console.log("Loading datasets...");
  const trainDs = loadDataset(db, "train");
  const valDs = loadDataset(db, "val");

  const corpsVocab = (db.prepare("SELECT count(*) as count FROM ml_corps_vocab").get() as any).count + 10;

  console.log(`Model V3: LSTM Units=64, SeqLen=${SEQ_LEN}, BatchSize=32`);
  const model = buildModelV3({
    corpsVocab,
    l2: 1e-4,
    dropout: 0.2,
    lstmUnits: 64
  });

  model.compile({
    optimizer: tf.train.adam(1e-3),
    loss: multiQuantileLoss(QUANTILES, TARGET_CAPTIONS.length)
  });

  const xTrainSeq = tf.tensor3d(trainDs.xSequence);
  const xTrainCorps = tf.tensor2d(trainDs.xContext.map(c => [c[1]]), [trainDs.xContext.length, 1], "int32");
  const yTrain = tf.tidy(() => tf.tensor2d(trainDs.yRecap).expandDims(-1).tile([1, 1, 3]).reshape([-1, 24]));

  const xValSeq = tf.tensor3d(valDs.xSequence);
  const xValCorps = tf.tensor2d(valDs.xContext.map(c => [c[1]]), [valDs.xContext.length, 1], "int32");
  const yVal = tf.tidy(() => tf.tensor2d(valDs.yRecap).expandDims(-1).tile([1, 1, 3]).reshape([-1, 24]));

  // Create progress logger for finals predictions
  const progressLogger = new ProgressLogger(db);

  await model.fit([xTrainSeq, xTrainCorps], yTrain, {
    epochs: 50,
    batchSize: 32,
    validationData: [[xValSeq, xValCorps], yVal],
    callbacks: [progressLogger],
    verbose: 0
  });

  const savePath = "file://./models/v3_trajectory";
  await model.save(savePath);
  console.log(`Model saved to ${savePath}`);
}

train().catch(console.error);
