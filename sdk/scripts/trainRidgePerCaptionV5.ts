import * as fs from "node:fs";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

type Dataset = {
  header: string[];
  rows: Array<{ features: number[]; targets: Record<Caption, number> }>;
};

type RidgeModel = {
  intercept: number;
  weights: number[];
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    input: get("--input")!,
    out: get("--out", "./ridge-model-v5.json")!,
    lambda: Number(get("--lambda", "1.0")),
  };
}

function parseCsv(path: string): Dataset {
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

  const nonFeature = new Set(["season", "split", "corps_key", "competition_slug"]);
  const featureIdx = header
    .map((name, idx) => ({ name, idx }))
    .filter((item) => !item.name.startsWith("target_"))
    .filter((item) => !nonFeature.has(item.name))
    .map((item) => item.idx);

  const featureNames = featureIdx.map((idx) => header[idx]!);

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

function solveRidge(features: number[][], targets: number[], lambda: number): RidgeModel {
  const n = features.length;
  const m = features[0]?.length ?? 0;
  if (n === 0 || m === 0) throw new Error("Empty training data");

  const meanX = new Array(m).fill(0);
  const meanY = targets.reduce((sum, value) => sum + value, 0) / n;

  for (const row of features) {
    for (let j = 0; j < m; j++) meanX[j] += row[j]!;
  }
  for (let j = 0; j < m; j++) meanX[j] /= n;

  const centered = features.map((row) => row.map((value, j) => value - meanX[j]!));
  const yCentered = targets.map((value) => value - meanY);

  const xtx = Array.from({ length: m }, () => new Array(m).fill(0));
  const xty = new Array(m).fill(0);

  for (let i = 0; i < n; i++) {
    const row = centered[i]!;
    const y = yCentered[i]!;
    for (let j = 0; j < m; j++) {
      xty[j] += row[j]! * y;
      for (let k = 0; k < m; k++) {
        xtx[j]![k] += row[j]! * row[k]!;
      }
    }
  }

  for (let j = 0; j < m; j++) {
    xtx[j]![j] += lambda;
  }

  const weights = gaussianSolve(xtx, xty);
  const intercept = meanY - weights.reduce((sum, w, j) => sum + w * meanX[j]!, 0);
  return { intercept, weights };
}

function gaussianSolve(matrix: number[][], vector: number[]): number[] {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, vector[i]!]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k]![i]!) > Math.abs(aug[maxRow]![i]!)) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow]!, aug[i]!];

    const pivot = aug[i]![i]!;
    if (Math.abs(pivot) < 1e-12) continue;

    for (let j = i; j <= n; j++) aug[i]![j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = aug[k]![i]!;
      for (let j = i; j <= n; j++) aug[k]![j] -= factor * aug[i]![j];
    }
  }

  return aug.map((row) => row[n]!);
}

function main() {
  const args = parseArgs();
  if (!args.input) throw new Error("--input is required");

  const dataset = parseCsv(args.input);

  const models: Record<Caption, RidgeModel> = {} as Record<Caption, RidgeModel>;
  for (const caption of CAPTIONS) {
    const targets = dataset.rows.map((row) => row.targets[caption]);
    const features = dataset.rows.map((row) => row.features);
    models[caption] = solveRidge(features, targets, args.lambda);
  }

  fs.writeFileSync(
    args.out,
    JSON.stringify({ lambda: args.lambda, featureNames: dataset.header, models }, null, 2)
  );
  console.log(`Wrote ridge models to ${args.out}`);
}

main();
