import * as fs from "node:fs";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

type RidgeModel = {
  intercept: number;
  weights: number[];
};

type RidgeFile = {
  lambda: number;
  featureNames: string[];
  models: Record<Caption, RidgeModel>;
};

type Dataset = {
  header: string[];
  rows: Array<{ features: number[]; targets: Record<Caption, number> }>;
};

type Metrics = {
  count: number;
  maeSum: number;
  mseSum: number;
};

type OutputFile = {
  model: string;
  errors: number[];
  absErrors: number[];
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    input: get("--input")!,
    model: get("--model")!,
    out: get("--out"),
  };
}

function parseCsv(path: string, featureNames: string[]): Dataset {
  const content = fs.readFileSync(path, "utf-8").trim();
  const [headerLine, ...lines] = content.split(/\r?\n/);
  if (!headerLine) throw new Error("CSV header missing");
  const header = headerLine.split(",");

  const targetIdx = new Map<Caption, number>();
  CAPTIONS.forEach((caption) => {
    const idx = header.indexOf(`target_${caption}`);
    if (idx < 0) throw new Error(`Missing target_${caption} column`);
    targetIdx.set(caption, idx);
  });

  const featureIdx = featureNames.map((name) => {
    const idx = header.indexOf(name);
    if (idx < 0) throw new Error(`Missing feature column ${name}`);
    return idx;
  });

  const rows = lines.map((line) => {
    const cols = line.split(",");
    const features = featureIdx.map((idx) => {
      const value = Number(cols[idx] ?? 0);
      return Number.isFinite(value) ? value : 0;
    });
    const targets = {} as Record<Caption, number>;
    CAPTIONS.forEach((caption) => {
      targets[caption] = Number(cols[targetIdx.get(caption)!] ?? 0);
    });
    return { features, targets };
  });

  return { header: featureNames, rows };
}

function predict(model: RidgeModel, features: number[]) {
  let value = model.intercept;
  for (let i = 0; i < model.weights.length; i++) {
    value += model.weights[i]! * (features[i] ?? 0);
  }
  return value;
}

function update(metrics: Metrics, error: number) {
  metrics.count += 1;
  metrics.maeSum += Math.abs(error);
  metrics.mseSum += error * error;
}

function finalize(metrics: Metrics) {
  return {
    count: metrics.count,
    mae: metrics.maeSum / metrics.count,
    rmse: Math.sqrt(metrics.mseSum / metrics.count),
  };
}

function main() {
  const args = parseArgs();
  if (!args.input || !args.model) throw new Error("--input and --model are required");

  const modelFile = JSON.parse(fs.readFileSync(args.model, "utf-8")) as RidgeFile;
  const dataset = parseCsv(args.input, modelFile.featureNames);

  const metricsByCaption = {} as Record<Caption, Metrics>;
  for (const caption of CAPTIONS) metricsByCaption[caption] = { count: 0, maeSum: 0, mseSum: 0 };
  const overall: Metrics = { count: 0, maeSum: 0, mseSum: 0 };

  const errors: number[] = [];
  const absErrors: number[] = [];

  for (const row of dataset.rows) {
    for (const caption of CAPTIONS) {
      const model = modelFile.models[caption];
      const pred = predict(model, row.features);
      const actual = row.targets[caption];
      const error = pred - actual;
      update(metricsByCaption[caption], error);
      update(overall, error);
      errors.push(error);
      absErrors.push(Math.abs(error));
    }
  }

  console.log("Ridge per-caption evaluation");
  console.log(`Total samples: ${overall.count}`);
  const overallSummary = finalize(overall);
  console.log(`Overall MAE=${overallSummary.mae.toFixed(4)} RMSE=${overallSummary.rmse.toFixed(4)}`);

  for (const caption of CAPTIONS) {
    const summary = finalize(metricsByCaption[caption]);
    console.log(`${caption} MAE=${summary.mae.toFixed(4)} RMSE=${summary.rmse.toFixed(4)} n=${summary.count}`);
  }

  if (args.out) {
    const output: OutputFile = { model: "ridge_per_caption_v5", errors, absErrors };
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
    console.log(`Wrote errors to ${args.out}`);
  }
}

main();
