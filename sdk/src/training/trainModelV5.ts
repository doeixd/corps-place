// import * as tf from "@tensorflow/tfjs";
// import "@tensorflow/tfjs-backend-cpu";


import * as tf from "@tensorflow/tfjs-node";
// tfjs-node exposes `io` as a runtime value but not a TS namespace, so derive the
// handler types from that value instead of `tf.io.X` (which fails type resolution).
type TfIOHandler = ReturnType<typeof tf.io.withSaveHandler>;
type TfModelArtifacts = Parameters<NonNullable<TfIOHandler["save"]>>[0];


import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v5_fixed_bilstm";
const SEQ_LEN = 15;
const FEAT_DIM = 57;
const STATIC_DIM = 53;
const BATCH_SIZE = 32;
const EPOCHS = 200;
const EARLY_STOPPING_PATIENCE = 20;
const PADDING_INDEX = 3;

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const OUTPUT_DIM = CAPTIONS.length * 3;

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  return {
    epochs: Number(get("--epochs", `${EPOCHS}`)),
    batchSize: Number(get("--batch", `${BATCH_SIZE}`)),
    maxRows: Number(get("--maxRows", "")) || undefined,
    patience: Number(get("--patience", `${EARLY_STOPPING_PATIENCE}`)),
    // Hyperparameters
    lstm1Units: Number(get("--lstm1-units", "64")),
    lstm2Units: Number(get("--lstm2-units", "32")),
    dropoutLstm: Number(get("--dropout-lstm", "0.2")),
    recurrentDropout: Number(get("--recurrent-dropout", "0.2")),
    dropoutDense1: Number(get("--dropout-dense1", "0.3")),
    dropoutDense2: Number(get("--dropout-dense2", "0.2")),
    l2Reg: Number(get("--l2-reg", "0.00005")),
    learningRate: Number(get("--lr", "0.0005")),
    // Logging
    logCsv: get("--log-csv", "./results/lstm-v5-training-log.csv"),
    trialId: get("--trial-id"),
  };
}

function quantileLoss(q: number, yTrue: tf.Tensor, yPred: tf.Tensor): tf.Tensor {
  const e = tf.sub(yTrue, yPred);
  return tf.mean(tf.maximum(tf.mul(q, e), tf.mul(q - 1, e)));
}

function multiQuantileLoss(yTrue: tf.Tensor, yPred: tf.Tensor): tf.Tensor {
  return tf.tidy(() => {
    const idxP10 = tf.tensor1d([0, 3, 6, 9, 12, 15, 18, 21], "int32");
    const idxP50 = tf.tensor1d([1, 4, 7, 10, 13, 16, 19, 22], "int32");
    const idxP90 = tf.tensor1d([2, 5, 8, 11, 14, 17, 20, 23], "int32");

    const p10 = yPred.gather(idxP10, 1);
    const p50 = yPred.gather(idxP50, 1);
    const p90 = yPred.gather(idxP90, 1);

    const t10 = yTrue.gather(idxP10, 1);
    const t50 = yTrue.gather(idxP50, 1);
    const t90 = yTrue.gather(idxP90, 1);

    return tf.addN([
      quantileLoss(0.1, t10, p10),
      quantileLoss(0.5, t50, p50),
      quantileLoss(0.9, t90, p90),
    ]);
  });
}

async function main() {
  const args = parseArgs();
  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("Loading V5 sequence data...");

  const result = await client.execute(`
    SELECT season, corps_key, x_sequence_json, x_static_json, y_residuals_json, split
    FROM ml_sequence_rows_v5
  `);
  const rows = result.rows as unknown as Array<{
    season: string;
    corps_key: string;
    x_sequence_json: string;
    x_static_json: string;
    y_residuals_json: string;
    split: string;
  }>;
  client.close();

  const prepareData = (targetSplit: string) => {
    const filtered = rows.filter((r) => r.split === targetSplit);
    if (!filtered.length) return null;
    const subset = args.maxRows ? filtered.slice(0, Math.min(args.maxRows, filtered.length)) : filtered;

    const xSeq: number[][][] = [];
    const xStatic: number[][] = [];
    const yTarget: number[][] = [];

    for (const row of subset) {
      const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
      const seq = rawSeq.map((step) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
      const stat = JSON.parse(row.x_static_json) as number[];
      const resids = JSON.parse(row.y_residuals_json) as Record<string, number>;

      if (seq.length !== SEQ_LEN || seq[0]?.length !== FEAT_DIM) continue;
      if (stat.length !== STATIC_DIM) continue;

      xSeq.push(seq);
      xStatic.push(stat);

      const rowY: number[] = [];
      for (const cap of CAPTIONS) {
        const val = resids[cap] ?? 0;
        rowY.push(val, val, val);
      }
      yTarget.push(rowY);
    }

    return {
      seq: tf.tensor3d(xSeq, [xSeq.length, SEQ_LEN, FEAT_DIM]),
      stat: tf.tensor2d(xStatic, [xStatic.length, STATIC_DIM]),
      y: tf.tensor2d(yTarget, [yTarget.length, OUTPUT_DIM]),
    };
  };

  const trainData = prepareData("train");
  const valData = prepareData("val");

  if (!trainData || !valData) {
    throw new Error("Missing train/val data for V5 model.");
  }

  console.log(`Train: ${trainData.seq.shape[0]}, Val: ${valData.seq.shape[0]}`);
  if (args.maxRows) {
    console.log(`Using maxRows=${args.maxRows} for quick training.`);
  }

  const seqInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "sequence" });
  const staticInput = tf.input({ shape: [STATIC_DIM], name: "static" });

  const maskedInput = tf.layers.masking({ maskValue: 0 }).apply(seqInput) as tf.SymbolicTensor;

  const lstm1 = tf.layers
    .bidirectional({
      layer: tf.layers.lstm({
        units: args.lstm1Units,
        returnSequences: true,
        dropout: args.dropoutLstm,
        recurrentDropout: args.recurrentDropout,
        kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
      }),
      mergeMode: "concat",
    })
    .apply(maskedInput) as tf.SymbolicTensor;

  const norm1 = tf.layers.layerNormalization().apply(lstm1) as tf.SymbolicTensor;

  const lstm2 = tf.layers
    .bidirectional({
      layer: tf.layers.lstm({
        units: args.lstm2Units,
        returnSequences: false,
        dropout: args.dropoutLstm,
        recurrentDropout: args.recurrentDropout,
        kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
      }),
      mergeMode: "concat",
    })
    .apply(norm1) as tf.SymbolicTensor;

  const norm2 = tf.layers.layerNormalization().apply(lstm2) as tf.SymbolicTensor;

  const concat = tf.layers.concatenate().apply([norm2, staticInput]) as tf.SymbolicTensor;

  const d1 = tf.layers
    .dense({
      units: 128,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(concat) as tf.SymbolicTensor;

  const d1Drop = tf.layers.dropout({ rate: args.dropoutDense1 }).apply(d1) as tf.SymbolicTensor;

  const d2 = tf.layers
    .dense({
      units: 64,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(d1Drop) as tf.SymbolicTensor;

  const d2Drop = tf.layers.dropout({ rate: args.dropoutDense2 }).apply(d2) as tf.SymbolicTensor;

  const output = tf.layers.dense({ units: OUTPUT_DIM, name: "output" }).apply(d2Drop) as tf.SymbolicTensor;

  const model = tf.model({ inputs: [seqInput, staticInput], outputs: output });

  const optimizer = tf.train.adam(args.learningRate);
  model.compile({ optimizer, loss: multiQuantileLoss });
  model.summary();

  console.log(`Hyperparameters: lstm1=${args.lstm1Units}, lstm2=${args.lstm2Units}, dropout=${args.dropoutLstm}, lr=${args.learningRate}, batch=${args.batchSize}`);

  // Enhanced logging callback with CSV export
  class DetailedLogger extends tf.Callback {
    private startTime = Date.now();
    private csvPath = args.logCsv;
    private csvInitialized = false;

    override async onEpochEnd(epoch: number, logs?: tf.Logs) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
      const loss = logs?.loss?.toFixed(6) ?? "N/A";
      const valLoss = logs?.val_loss?.toFixed(6) ?? "N/A";

      console.log(`Epoch ${epoch}: loss=${loss} val_loss=${valLoss} time=${elapsed}s`);

      // Log to CSV
      if (this.csvPath) {
        const csvLine = `${args.trialId ?? "default"},${epoch},${loss},${valLoss},${args.learningRate},${elapsed},${args.lstm1Units},${args.lstm2Units},${args.dropoutLstm},${args.batchSize}\n`;

        if (!this.csvInitialized) {
          const header = "trial_id,epoch,train_loss,val_loss,learning_rate,elapsed_sec,lstm1_units,lstm2_units,dropout,batch_size\n";
          fs.writeFileSync(this.csvPath, header, { flag: "a" });
          this.csvInitialized = true;
        }

        fs.appendFileSync(this.csvPath, csvLine);
      }

      // Detect issues
      if (logs?.val_loss && (isNaN(logs.val_loss) || !isFinite(logs.val_loss))) {
        console.warn(`WARNING: val_loss is NaN or infinite at epoch ${epoch}`);
      }
    }
  }

  class BestCheckpoint extends tf.Callback {
    private bestLoss = Number.POSITIVE_INFINITY;
    private bestWeights: tf.Tensor[] | null = null;

    override async onEpochEnd(_epoch: number, logs?: tf.Logs) {
      const valLoss = logs?.val_loss;
      if (valLoss == null || !Number.isFinite(valLoss)) return;
      if (valLoss < this.bestLoss) {
        this.bestLoss = valLoss;
        if (this.bestWeights) {
          this.bestWeights.forEach((tensor) => tensor.dispose());
        }
        this.bestWeights = model.getWeights().map((tensor) => tensor.clone());
      }
    }

    restoreBest() {
      if (!this.bestWeights) return;
      model.setWeights(this.bestWeights);
      this.bestWeights.forEach((tensor) => tensor.dispose());
      this.bestWeights = null;
    }
  }

  const bestCheckpoint = new BestCheckpoint();

  await model.fit([trainData.seq, trainData.stat], trainData.y, {
    epochs: args.epochs,
    batchSize: args.batchSize,
    validationData: [[valData.seq, valData.stat], valData.y],
    callbacks: [
      bestCheckpoint,
      tf.callbacks.earlyStopping({ monitor: "val_loss", patience: args.patience }),
      new DetailedLogger(),
    ],
  });

  bestCheckpoint.restoreBest();
  console.log("Saving model...");
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }

  const saveHandler = {
    save: async (modelArtifacts: TfModelArtifacts) => {
      if (modelArtifacts.weightData) {
        let buffer: Buffer;
        if (modelArtifacts.weightData instanceof ArrayBuffer) {
          buffer = Buffer.from(new Uint8Array(modelArtifacts.weightData));
        } else {
          buffer = Buffer.concat(modelArtifacts.weightData.map((b) => Buffer.from(new Uint8Array(b))));
        }
        fs.writeFileSync(path.join(MODEL_DIR, "weights.bin"), buffer);
      }

      const modelJson = {
        modelTopology: modelArtifacts.modelTopology,
        weightsManifest: [{ paths: ["weights.bin"], weights: modelArtifacts.weightSpecs }],
        format: modelArtifacts.format,
        generatedBy: modelArtifacts.generatedBy,
        convertedBy: modelArtifacts.convertedBy,
      };
      fs.writeFileSync(path.join(MODEL_DIR, "model.json"), JSON.stringify(modelJson));

      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: "JSON" as const,
        },
      };
    },
  } satisfies TfIOHandler;

  await model.save(saveHandler);
  tf.dispose([trainData.seq, trainData.stat, trainData.y, valData.seq, valData.stat, valData.y]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
