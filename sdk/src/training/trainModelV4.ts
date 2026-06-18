
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Config
const DB_PATH = './dci-relational.db';
const MODEL_SAVE_PATH = 'file://./models/v4_trajectory';
const SEQ_LEN = 15;
const FEAT_DIM = 40;
const BATCH_SIZE = 64;
const EPOCHS = 20;

// Captions
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
const OUTPUT_DIM = CAPTIONS.length * 3; // 24 (p10, p50, p90)

// Helper: Quantile Loss
function quantileLoss(q: number, yTrue: tf.Tensor, yPred: tf.Tensor): tf.Tensor {
  const e = tf.sub(yTrue, yPred);
  return tf.mean(tf.maximum(tf.mul(q, e), tf.mul(q - 1, e)));
}

// Custom Loss
function multiQuantileLoss(yTrue: tf.Tensor, yPred: tf.Tensor): tf.Tensor {
  return tf.tidy(() => {
    // Indices for p10, p50, p90 (0, 3, 6...; 1, 4, 7...; 2, 5, 8...)
    const idxP10 = tf.tensor1d([0, 3, 6, 9, 12, 15, 18, 21], 'int32');
    const idxP50 = tf.tensor1d([1, 4, 7, 10, 13, 16, 19, 22], 'int32');
    const idxP90 = tf.tensor1d([2, 5, 8, 11, 14, 17, 20, 23], 'int32');

    const p10 = yPred.gather(idxP10, 1);
    const p50 = yPred.gather(idxP50, 1);
    const p90 = yPred.gather(idxP90, 1);

    // yTrue is replicated [target, target, target...] so any slice works to get target
    const t_p10 = yTrue.gather(idxP10, 1);
    const t_p50 = yTrue.gather(idxP50, 1);
    const t_p90 = yTrue.gather(idxP90, 1);

    const l1 = quantileLoss(0.1, t_p10, p10);
    const l2 = quantileLoss(0.5, t_p50, p50);
    const l3 = quantileLoss(0.9, t_p90, p90);

    return tf.add(tf.add(l1, l2), l3);
  });
}

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });
  console.log('Loading V4 sequence data...');

  // 1. Load Data
  const result = await client.execute(`
    SELECT season, corps_key, x_sequence_json, y_residuals_json, split 
    FROM ml_sequence_rows_v4
  `);
  const rows = result.rows;

  // 2. Build Vocabulary
  const corpsSet = new Set<string>();
  const seasonSet = new Set<string>();
  rows.forEach((r: any) => {
    corpsSet.add(r.corps_key as string);
    seasonSet.add(r.season as string);
  });

  const corpsList = Array.from(corpsSet).sort();
  const seasonList = Array.from(seasonSet).sort();
  const corpsMap = new Map(corpsList.map((c, i) => [c, i + 1])); // 0=padding
  const seasonMap = new Map(seasonList.map((s, i) => [s, i + 1]));

  console.log(`Vocab: ${corpsList.length} corps, ${seasonList.length} seasons`);

  // 3. Prepare Tensors
  function prepareData(targetSplit: string) {
    const subset = rows.filter((r: any) => r.split === targetSplit); // or handle train/val
    if (subset.length === 0) return null;

    const xSeq: number[][][] = [];
    const xCorps: number[] = [];
    const xSeason: number[] = [];
    const yTarget: number[][] = []; // [batch, 24]

    subset.forEach((r: any) => {
      const seq = JSON.parse(r.x_sequence_json); // [15, 40]
      const resids = JSON.parse(r.y_residuals_json);

      xSeq.push(seq);
      xCorps.push(corpsMap.get(r.corps_key)!);
      xSeason.push(seasonMap.get(r.season)!);

      // Build y vector: [GE1_p10, GE1_p50, GE1_p90, GE2_p10...]
      // Since yTrue is a single value (actual - baseline), we use it for all 3 quantiles in loss calc? 
      // Or we replicate it 3 times here.
      // Let's replicate it.
      const rowY: number[] = [];
      for (const cap of CAPTIONS) {
        const val = resids[cap] || 0;
        rowY.push(val, val, val);
      }
      yTarget.push(rowY);
    });

    return {
      seq: tf.tensor3d(xSeq, [subset.length, SEQ_LEN, FEAT_DIM]),
      corps: tf.tensor2d(xCorps, [subset.length, 1]),
      season: tf.tensor2d(xSeason, [subset.length, 1]),
      y: tf.tensor2d(yTarget, [subset.length, OUTPUT_DIM])
    };
  }

  const trainData = prepareData('train')!;
  const valData = prepareData('val')!;
  // const testData = prepareData('test');

  console.log(`Train: ${trainData.seq.shape[0]}, Val: ${valData.seq.shape[0]}`);

  // 4. Build Model
  const seqInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: 'sequence' });
  const corpsInput = tf.input({ shape: [1], name: 'corps' });
  const seasonInput = tf.input({ shape: [1], name: 'season' });

  // 1. Sequence Branch (LSTM)
  // Reduced capacity and added dropout as per recommendations
  const x1 = tf.layers.bidirectional({
    layer: tf.layers.lstm({
      units: 64,
      returnSequences: true,
      dropout: 0.3,
      recurrentDropout: 0.3
    }),
    mergeMode: 'concat'
  }).apply(seqInput);

  // Second LSTM layer
  const x2 = tf.layers.bidirectional({
    layer: tf.layers.lstm({
      units: 32,
      returnSequences: false, // Last step only
      dropout: 0.3,
      recurrentDropout: 0.3
    }),
    mergeMode: 'concat'
  }).apply(x1);

  // Dropout after LSTM
  const x2_dropped = tf.layers.dropout({ rate: 0.3 }).apply(x2);

  // 2. Embeddings
  const empCorps = tf.layers.embedding({ inputDim: corpsList.length + 1, outputDim: 8 }).apply(corpsInput);
  const empSeason = tf.layers.embedding({ inputDim: seasonList.length + 1, outputDim: 4 }).apply(seasonInput);

  const flatCorps = tf.layers.flatten().apply(empCorps);
  const flatSeason = tf.layers.flatten().apply(empSeason);

  // 3. Concatenate
  const concat = tf.layers.concatenate().apply([x2_dropped as tf.SymbolicTensor, flatCorps as tf.SymbolicTensor, flatSeason as tf.SymbolicTensor]);

  // 4. Dense Layers (Residual Prediction)
  // Added L2 regularization
  const d1 = tf.layers.dense({
    units: 256,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 })
  }).apply(concat);

  const d1_drop = tf.layers.dropout({ rate: 0.3 }).apply(d1); // Increased dropout

  const d2 = tf.layers.dense({
    units: 128,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 })
  }).apply(d1_drop);

  // Output Head
  const output = tf.layers.dense({ units: OUTPUT_DIM, name: 'output' }).apply(d2);

  const model = tf.model({ inputs: [seqInput, corpsInput, seasonInput], outputs: output as tf.SymbolicTensor });

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: multiQuantileLoss
  });

  model.summary();

  // 5. Train
  console.log('Starting training...');
  // Define simple logger
  class EpochLogger extends tf.Callback {
    override async onBatchEnd(batch: number, logs?: tf.Logs) {
      if (batch % 10 === 0) {
        console.log(`Batch ${batch} completed...`);
      }
    }
    override async onEpochEnd(epoch: number, logs?: tf.Logs) {
      console.log(`\nEpoch ${epoch}: loss=${logs?.loss?.toFixed(4)} val_loss=${logs?.val_loss?.toFixed(4)}`);
    }
  }

  await model.fit([trainData.seq, trainData.corps, trainData.season], trainData.y, {
    epochs: 100,
    batchSize: BATCH_SIZE,
    validationData: [[valData.seq, valData.corps, valData.season], valData.y],
    callbacks: [
      tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 15 }),
      new EpochLogger()
    ]
  });

  // Save logic using manual IO handler since file:// is not supported in basic tfjs
  console.log('Saving model...');
  const saveHandler = {
    save: async (modelArtifacts: tf.io.ModelArtifacts) => {
      const modelDir = './models/v4_trajectory';
      if (!fs.existsSync(modelDir)) {
        fs.mkdirSync(modelDir, { recursive: true });
      }

      // Save weights
      if (modelArtifacts.weightData) {
        let finalBuffer: Buffer;
        if (modelArtifacts.weightData instanceof ArrayBuffer) {
          finalBuffer = Buffer.from(new Uint8Array(modelArtifacts.weightData));
        } else {
          finalBuffer = Buffer.concat(modelArtifacts.weightData.map(b => Buffer.from(new Uint8Array(b))));
        }
        fs.writeFileSync(path.join(modelDir, 'weights.bin'), finalBuffer);
      }

      // Save model.json
      const modelJson = {
        modelTopology: modelArtifacts.modelTopology,
        weightsManifest: [{
          paths: ['weights.bin'],
          weights: modelArtifacts.weightSpecs
        }],
        format: modelArtifacts.format,
        generatedBy: modelArtifacts.generatedBy,
        convertedBy: modelArtifacts.convertedBy
      };
      fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify(modelJson));

      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON' as const
        }
      };
    }
  };

  await model.save(saveHandler);
  console.log(`Model saved to ./models/v4_trajectory`);
}

main().catch(console.error);
