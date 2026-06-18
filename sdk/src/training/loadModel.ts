// ml/serve/loadModel.ts
//
// Loads trained DCI prediction model with support for both TensorFlow.js and ONNX Runtime.
// Provides:
// - buildNumericVector(partialFeatures) using features.json order + defaults
// - normalize numeric vector
// - pad judges
// - predictBatch -> {p10,p50,p90}
//
// deps:
//   npm i onnxruntime-node
//
// For TF.js fallback: npm i @tensorflow/tfjs-node

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tensor } from "onnxruntime-node";


export type NormStats = { mean: number[]; std: number[] };
export type FeatureSpec = {
  version: string;
  numericOrder: Array<{ name: string; defaultValue: number; missingFlag?: string }>;
  notes?: string;
};

export type PredictInput = {
  // You can pass ids directly (recommended for robustness).
  corpsId: number;
  seasonId: number;
  divisionId: number;

  // Optional judge ids (any length; will be padded).
  judgeIds?: number[];

  // Partial numeric feature map keyed by name in features.json
  // Missing values will be filled with defaults from features.json.
  numeric?: Record<string, number | null | undefined>;
};

export type PredictOutput = {
  p10: number;
  p50: number;
  p90: number;
};

export type ModelBackend = "onnx" | "tfjs";

export interface LoadedModel {
  modelDir: string;
  backend: ModelBackend;
  norm: NormStats;
  features: FeatureSpec;
  useJudges: boolean;
  maxJudges: number;

  buildNumericVector: (partial?: Record<string, number | null | undefined>) => number[];
  normalizeNumeric: (vec: number[]) => number[];
  padJudgeIds: (ids?: number[]) => number[];

  predictBatch: (inputs: PredictInput[]) => Promise<PredictOutput[]>;

  dispose: () => void;
}

function normalize(vec: number[], norm: NormStats): number[] {
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i]! - norm.mean[i]!) / norm.std[i]!;
  }
  return out;
}

function pad(ids: number[] | undefined, maxJudges: number, maxVocabId?: number): number[] {
  let base = (ids ?? []).map((x) => Math.trunc(x)).filter((x) => Number.isFinite(x) && x >= 0);

  // Clip judge IDs to valid vocab range if maxVocabId is provided
  if (maxVocabId !== undefined) {
    base = base.map(id => id >= maxVocabId ? 0 : id);
  }

  const out = base.slice(0, maxJudges);
  while (out.length < maxJudges) out.push(0);
  return out;
}

function buildNumericVectorFromSpec(
  spec: FeatureSpec,
  partial?: Record<string, number | null | undefined>
): number[] {
  // Start with defaults
  const out: Record<string, number> = {};
  for (const item of spec.numericOrder) {
    out[item.name] = item.defaultValue;
  }

  // Apply provided values + missingFlag semantics
  if (partial) {
    for (const item of spec.numericOrder) {
      const v = partial[item.name];
      const isMissing = v === undefined || v === null || Number.isNaN(v);

      if (!isMissing) {
        out[item.name] = Number(v);
        if (item.missingFlag) out[item.missingFlag] = 1;
      } else {
        // Missing: keep default
        if (item.missingFlag) out[item.missingFlag] = 0;
      }
    }
  }

  // Return in order
  return spec.numericOrder.map((item) => out[item.name]!);
}

// ----- ONNX Runtime Backend -----

interface OnnxSession {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array | Int32Array }>>;
  dispose: () => void;
}

async function loadOnnxModel(modelPath: string): Promise<OnnxSession | null> {
  try {
    // Dynamic import to avoid hard dependency
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(modelPath);
    return {
      run: async (feeds) => {
        const onnxFeeds: Record<string, Tensor> = {};

        for (const [key, value] of Object.entries(feeds)) {
          if (Array.isArray(value)) {
            const flat = value.flat();
            if (key.includes("id") || key === "judge_ids") {
              onnxFeeds[key] = new ort.Tensor("int32", new Int32Array(flat), inferShape(value));
            } else {
              onnxFeeds[key] = new ort.Tensor("float32", new Float32Array(flat), inferShape(value));
            }
          }
        }
        const results = await session.run(onnxFeeds);
        return results as Record<string, { data: Float32Array | Int32Array }>;
      },
      dispose: () => {
        // ONNX sessions don't have explicit dispose in Node
      },
    };
  } catch (e) {
    console.warn("ONNX Runtime not available, will try TF.js fallback:", e);
    return null;
  }
}

function inferShape(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  if (arr.length === 0) return [0];
  if (!Array.isArray(arr[0])) return [arr.length];
  return [arr.length, ...inferShape(arr[0])];
}

// ----- TensorFlow.js Backend -----

interface TfjsModel {
  predict: (inputs: unknown[]) => { arraySync: () => number[][] };
  dispose: () => void;
}

async function loadTfjsModel(modelJsonPath: string): Promise<TfjsModel | null> {
  try {
    const tf = await import("@tensorflow/tfjs");
    await import("@tensorflow/tfjs-backend-cpu");

    // Create a custom IOHandler to load from the file system
    const modelDir = path.dirname(modelJsonPath);
    let modelTopology = JSON.parse(fs.readFileSync(modelJsonPath, "utf8"));

    // Handle double-stringified JSON (if model.toJSON() returned a string)
    if (typeof modelTopology === 'string') {
      modelTopology = JSON.parse(modelTopology);
    }

    // Load model from topology only (without weights initially)
    const model = await tf.models.modelFromJSON(modelTopology);

    // Get expected weight shapes from the model
    const expectedShapes = model.weights.map((w: any) => w.shape);

    // Load weight files  (weight_0.bin, weight_1.bin, ...)
    const weightFiles = fs.readdirSync(modelDir).filter((f: string) => f.startsWith('weight_') && f.endsWith('.bin')).sort();
    const weightTensors: any[] = [];

    for (let i = 0; i < weightFiles.length; i++) {
      const weightFile = weightFiles[i]!;
      const weightPath = path.join(modelDir, weightFile);
      const buffer = fs.readFileSync(weightPath);
      const float32Array = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

      // Reshape according to expected shape
      const expectedShape = expectedShapes[i];
      if (expectedShape) {
        weightTensors.push(tf.tensor(Array.from(float32Array), expectedShape));
      } else {
        weightTensors.push(tf.tensor(Array.from(float32Array)));
      }
    }

    // Set weights on the model
    if (weightTensors.length > 0) {
      model.setWeights(weightTensors);
    }
    return {
      predict: (inputs: unknown[]) => {
        const tensors = inputs.map((input, idx) => {
          const arr = input as number[][];
          if (idx === 0) {
            return tf.tensor2d(arr, [arr.length, arr[0]!.length], "float32");
          } else {
            return tf.tensor2d(arr, [arr.length, arr[0]!.length], "int32");
          }
        });
        const result = model.predict(tensors) as ReturnType<typeof tf.tensor>;
        return {
          arraySync: () => result.arraySync() as number[][],
        };
      },
      dispose: () => model.dispose(),
    };
  } catch (e) {
    console.warn("TF.js not available:", e);
    return null;
  }
}

// ----- Main Loader -----

export type LoadDciModelOptions = {
  useJudges?: boolean;
  maxJudges?: number;
  preferBackend?: ModelBackend;
};

export async function loadDciModel(
  modelDir: string,
  opts?: LoadDciModelOptions
): Promise<LoadedModel> {
  const useJudges = opts?.useJudges ?? true;
  const maxJudges = opts?.maxJudges ?? 16;
  const preferBackend = opts?.preferBackend ?? "onnx";

  // Load config files
  const normPath = path.join(modelDir, "numeric_norm.json");
  const featuresPath = path.join(modelDir, "features.json");
  const metadataPath = path.join(modelDir, "metadata.json");

  if (!fs.existsSync(normPath)) {
    throw new Error(`Missing numeric_norm.json in ${modelDir}`);
  }
  if (!fs.existsSync(featuresPath)) {
    throw new Error(`Missing features.json in ${modelDir}`);
  }

  const norm = JSON.parse(fs.readFileSync(normPath, "utf8")) as NormStats;
  const features = JSON.parse(fs.readFileSync(featuresPath, "utf8")) as FeatureSpec;

  // Load metadata to get vocab sizes (optional)
  let judgeVocabSize: number | undefined;
  let corpsVocabSize: number | undefined;
  let seasonVocabSize: number | undefined;
  let divisionVocabSize: number | undefined;
  if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    judgeVocabSize = metadata.vocab?.judgeVocab;
    corpsVocabSize = metadata.vocab?.corpsVocab;
    seasonVocabSize = metadata.vocab?.seasonVocab;
    divisionVocabSize = metadata.vocab?.divisionVocab;
  }

  // Try to load model
  let backend: ModelBackend;
  let onnxSession: OnnxSession | null = null;
  let tfjsModel: TfjsModel | null = null;

  const onnxPath = path.join(modelDir, "model.onnx");
  const tfjsPath = path.join(modelDir, "model.json");

  if (preferBackend === "onnx" && fs.existsSync(onnxPath)) {
    onnxSession = await loadOnnxModel(onnxPath);
    if (onnxSession) {
      backend = "onnx";
    } else if (fs.existsSync(tfjsPath)) {
      tfjsModel = await loadTfjsModel(tfjsPath);
      if (!tfjsModel) throw new Error("No ML runtime available (tried ONNX and TF.js)");
      backend = "tfjs";
    } else {
      throw new Error("No model file found (model.onnx or model.json)");
    }
  } else if (fs.existsSync(tfjsPath)) {
    tfjsModel = await loadTfjsModel(tfjsPath);
    if (tfjsModel) {
      backend = "tfjs";
    } else if (fs.existsSync(onnxPath)) {
      onnxSession = await loadOnnxModel(onnxPath);
      if (!onnxSession) throw new Error("No ML runtime available (tried TF.js and ONNX)");
      backend = "onnx";
    } else {
      throw new Error("No model file found (model.json or model.onnx)");
    }
  } else if (fs.existsSync(onnxPath)) {
    onnxSession = await loadOnnxModel(onnxPath);
    if (!onnxSession) throw new Error("ONNX Runtime not available and no TF.js model found");
    backend = "onnx";
  } else {
    throw new Error(`No model file found in ${modelDir} (expected model.onnx or model.json)`);
  }

  // Build helper functions
  const buildNumericVector = (partial?: Record<string, number | null | undefined>) =>
    buildNumericVectorFromSpec(features, partial);

  const normalizeNumeric = (vec: number[]) => normalize(vec, norm);

  const padJudgeIds = (ids?: number[]) => pad(ids, maxJudges, judgeVocabSize);

  // Helper to clip ID to valid range (map out-of-vocab to 0/UNK)
  const clipId = (id: number, maxVocab?: number): number => {
    if (maxVocab !== undefined && id >= maxVocab) {
      return 0; // Map to UNK
    }
    return id;
  };

  // Prediction function
  const predictBatch = async (inputs: PredictInput[]): Promise<PredictOutput[]> => {
    if (inputs.length === 0) return [];

    // Build input arrays
    const xNumeric: number[][] = [];
    const corpsIds: number[][] = [];
    const seasonIds: number[][] = [];
    const divisionIds: number[][] = [];
    const judgeIdsArr: number[][] = [];

    for (const input of inputs) {
      const numericVec = buildNumericVector(input.numeric);
      const normalizedVec = normalizeNumeric(numericVec);
      xNumeric.push(normalizedVec);
      corpsIds.push([clipId(input.corpsId, corpsVocabSize)]);
      seasonIds.push([clipId(input.seasonId, seasonVocabSize)]);
      divisionIds.push([clipId(input.divisionId, divisionVocabSize)]);
      if (useJudges) {
        judgeIdsArr.push(padJudgeIds(input.judgeIds));
      }
    }

    let outputData: number[][];

    if (backend === "onnx" && onnxSession) {
      const feeds: Record<string, number[][]> = {
        x_numeric: xNumeric,
        corps_id: corpsIds,
        season_id: seasonIds,
        division_id: divisionIds,
      };
      if (useJudges) {
        feeds.judge_ids = judgeIdsArr;
      }

      const results = await onnxSession.run(feeds);
      // Assuming output is named "y_quantiles" or similar
      const outputKey = Object.keys(results).find((k) => k.includes("quantile") || k.includes("output") || k === "y_quantiles") ?? Object.keys(results)[0]!;
      const rawOutput = results[outputKey]!.data as Float32Array;

      // Reshape to [batch, 3]
      outputData = [];
      for (let i = 0; i < inputs.length; i++) {
        outputData.push([rawOutput[i * 3]!, rawOutput[i * 3 + 1]!, rawOutput[i * 3 + 2]!]);
      }
    } else if (backend === "tfjs" && tfjsModel) {
      const inputArrays: number[][][] = [xNumeric, corpsIds, seasonIds, divisionIds];
      if (useJudges) {
        inputArrays.push(judgeIdsArr);
      }
      const result = tfjsModel.predict(inputArrays);
      outputData = result.arraySync();
    } else {
      throw new Error("No model loaded");
    }

    // Parse outputs
    // If model outputs 3 values per row, treat as [p10, p50, p90]
    // If model outputs 1 value per row, use it as p50 (median prediction)
    return outputData.map((row) => {
      if (row.length >= 3) {
        return {
          p10: row[0]!,
          p50: row[1]!,
          p90: row[2]!,
        };
      } else {
        // Single value output - use as median with simple uncertainty estimate
        const value = row[0]!;
        return {
          p10: value - 2.0,  // Simple uncertainty: +/- 2 points
          p50: value,
          p90: value + 2.0,
        };
      }
    });
  };

  const dispose = () => {
    if (tfjsModel) tfjsModel.dispose();
    if (onnxSession) onnxSession.dispose();
  };

  return {
    modelDir,
    backend: backend!,
    norm,
    features,
    useJudges,
    maxJudges,
    buildNumericVector,
    normalizeNumeric,
    padJudgeIds,
    predictBatch,
    dispose,
  };
}
