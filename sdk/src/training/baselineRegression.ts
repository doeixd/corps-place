import { createClient } from "@libsql/client";
import * as fs from "node:fs";

const DB_PATH = "./dci-relational.db";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const rmse = (errors: number[]) => {
  if (!errors.length) return 0;
  const mse = errors.reduce((sum, value) => sum + value * value, 0) / errors.length;
  return Math.sqrt(mse);
};

const parseArgs = () => {
  const argv = process.argv.slice(2);
  const get = (key: string, fallback?: string) => {
    const idx = argv.indexOf(key);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };

  return {
    split: (get("--split", "all") || "all").toLowerCase(),
    outputJson: get("--output-json", "./results/baseline-regression.json") || "./results/baseline-regression.json",
    outputCsv: get("--output-csv", "./results/baseline-regression.csv") || "./results/baseline-regression.csv",
  };
};

const fitLinear = (xValues: number[], yValues: number[]) => {
  if (xValues.length !== yValues.length || !xValues.length) {
    return { slope: 0, intercept: 0, mae: 0, rmse: 0, r2: 0 };
  }

  const xMean = mean(xValues);
  const yMean = mean(yValues);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xValues.length; i++) {
    const dx = xValues[i]! - xMean;
    const dy = yValues[i]! - yMean;
    cov += dx * dy;
    varX += dx * dx;
  }

  const slope = varX > 0 ? cov / varX : 0;
  const intercept = yMean - slope * xMean;

  const errors = yValues.map((y, i) => y - (slope * xValues[i]! + intercept));
  const mae = mean(errors.map((value) => Math.abs(value)));
  const rmseValue = rmse(errors);
  const sse = errors.reduce((sum, value) => sum + value * value, 0);
  const sst = yValues.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;

  return { slope, intercept, mae, rmse: rmseValue, r2 };
};

const fitQuadratic = (xValues: number[], yValues: number[]) => {
  if (xValues.length !== yValues.length || !xValues.length) {
    return { a: 0, b: 0, c: 0, mae: 0, rmse: 0, r2: 0 };
  }

  const n = xValues.length;
  let sumX = 0;
  let sumX2 = 0;
  let sumX3 = 0;
  let sumX4 = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2Y = 0;

  for (let i = 0; i < n; i++) {
    const x = xValues[i]!;
    const y = yValues[i]!;
    const x2 = x * x;
    sumX += x;
    sumX2 += x2;
    sumX3 += x2 * x;
    sumX4 += x2 * x2;
    sumY += y;
    sumXY += x * y;
    sumX2Y += x2 * y;
  }

  const det =
    n * (sumX2 * sumX4 - sumX3 * sumX3) -
    sumX * (sumX * sumX4 - sumX2 * sumX3) +
    sumX2 * (sumX * sumX3 - sumX2 * sumX2);

  if (Math.abs(det) < 1e-8) {
    return { a: 0, b: 0, c: 0, mae: 0, rmse: 0, r2: 0 };
  }

  const detA =
    sumY * (sumX2 * sumX4 - sumX3 * sumX3) -
    sumX * (sumXY * sumX4 - sumX3 * sumX2Y) +
    sumX2 * (sumXY * sumX3 - sumX2 * sumX2Y);

  const detB =
    n * (sumXY * sumX4 - sumX3 * sumX2Y) -
    sumY * (sumX * sumX4 - sumX2 * sumX3) +
    sumX2 * (sumX * sumX2Y - sumXY * sumX2);

  const detC =
    n * (sumX2 * sumX2Y - sumXY * sumX3) -
    sumX * (sumX * sumX2Y - sumXY * sumX2) +
    sumY * (sumX * sumX3 - sumX2 * sumX2);

  const a = detA / det;
  const b = detB / det;
  const c = detC / det;

  const yMean = mean(yValues);
  const errors = yValues.map((y, i) => y - (a + b * xValues[i]! + c * xValues[i]! * xValues[i]!));
  const mae = mean(errors.map((value) => Math.abs(value)));
  const rmseValue = rmse(errors);
  const sse = errors.reduce((sum, value) => sum + value * value, 0);
  const sst = yValues.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;

  return { a, b, c, mae, rmse: rmseValue, r2 };
};

const fitPiecewise = (xValues: number[], yValues: number[]) => {
  if (xValues.length !== yValues.length || !xValues.length) {
    return {
      threshold: 0,
      left: { slope: 0, intercept: 0 },
      right: { slope: 0, intercept: 0 },
      mae: 0,
      rmse: 0,
      r2: 0,
    };
  }

  const threshold = mean(xValues);
  const leftX: number[] = [];
  const leftY: number[] = [];
  const rightX: number[] = [];
  const rightY: number[] = [];

  for (let i = 0; i < xValues.length; i++) {
    const x = xValues[i]!;
    if (x <= threshold) {
      leftX.push(x);
      leftY.push(yValues[i]!);
    } else {
      rightX.push(x);
      rightY.push(yValues[i]!);
    }
  }

  const leftFit = fitLinear(leftX, leftY);
  const rightFit = fitLinear(rightX, rightY);

  const yMean = mean(yValues);
  const errors = yValues.map((y, i) => {
    const x = xValues[i]!;
    const prediction = x <= threshold
      ? leftFit.slope * x + leftFit.intercept
      : rightFit.slope * x + rightFit.intercept;
    return y - prediction;
  });
  const mae = mean(errors.map((value) => Math.abs(value)));
  const rmseValue = rmse(errors);
  const sse = errors.reduce((sum, value) => sum + value * value, 0);
  const sst = yValues.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;

  return {
    threshold,
    left: { slope: leftFit.slope, intercept: leftFit.intercept },
    right: { slope: rightFit.slope, intercept: rightFit.intercept },
    mae,
    rmse: rmseValue,
    r2,
  };
};

const computeTotals = (captions: Record<string, number>) => {
  const ge = (captions.GE1 ?? 0) + (captions.GE2 ?? 0);
  const visual = ((captions.VP ?? 0) + (captions.VA ?? 0) + (captions.CG ?? 0)) / 2;
  const music = ((captions.MB ?? 0) + (captions.MA ?? 0) + (captions.MP ?? 0)) / 2;
  return ge + visual + music;
};

const main = async () => {
  const args = parseArgs();
  const client = createClient({ url: `file:${DB_PATH}` });

  const result = await client.execute(`
    SELECT y_recap_json, y_residuals_json, y_total, split
    FROM ml_sequence_rows_v7
  `);
  client.close();

  const rows = result.rows as unknown as Array<{
    y_recap_json: string;
    y_residuals_json: string;
    y_total: number;
    split: string;
  }>;

  const filtered = args.split === "all"
    ? rows
    : rows.filter((row) => row.split?.toLowerCase() === args.split);

  const baselineByCaption: Record<string, number[]> = {};
  const actualByCaption: Record<string, number[]> = {};
  for (const caption of CAPTIONS) {
    baselineByCaption[caption] = [];
    actualByCaption[caption] = [];
  }
  const baselineTotal: number[] = [];
  const actualTotal: number[] = [];

  for (const row of filtered) {
    const recap = JSON.parse(row.y_recap_json) as Record<string, number>;
    const residuals = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const baselineCaptions: Record<string, number> = {};

    for (const caption of CAPTIONS) {
      const actual = recap[caption] ?? 0;
      const residual = residuals[caption] ?? 0;
      const baseline = actual - residual;
      baselineCaptions[caption] = baseline;
      baselineByCaption[caption].push(baseline);
      actualByCaption[caption].push(actual);
    }

    baselineTotal.push(computeTotals(baselineCaptions));
    actualTotal.push(Number(row.y_total ?? 0));
  }

  const buildModels = (xValues: number[], yValues: number[]) => ({
    count: xValues.length,
    linear: fitLinear(xValues, yValues),
    quadratic: fitQuadratic(xValues, yValues),
    piecewise: fitPiecewise(xValues, yValues),
  });

  const captionResults = CAPTIONS.map((caption) => ({
    caption,
    ...buildModels(baselineByCaption[caption], actualByCaption[caption]),
  }));

  const totalResult = {
    caption: "TOTAL",
    ...buildModels(baselineTotal, actualTotal),
  };

  const output = {
    split: args.split,
    count: filtered.length,
    generatedAt: new Date().toISOString(),
    captions: captionResults,
    total: totalResult,
  };

  fs.writeFileSync(args.outputJson, JSON.stringify(output, null, 2));

  const csvHeader = [
    "caption",
    "model",
    "count",
    "mae",
    "rmse",
    "r2",
    "slope",
    "intercept",
    "quadratic",
    "threshold",
    "slope_left",
    "intercept_left",
    "slope_right",
    "intercept_right",
  ].join(",");

  const format = (value?: number) => (Number.isFinite(value) ? value!.toFixed(6) : "");

  const csvLines = [csvHeader];
  const pushLinear = (caption: string, count: number, stats: ReturnType<typeof fitLinear>) => {
    csvLines.push([
      caption,
      "linear",
      count,
      format(stats.mae),
      format(stats.rmse),
      format(stats.r2),
      format(stats.slope),
      format(stats.intercept),
      "",
      "",
      "",
      "",
      "",
      "",
    ].join(","));
  };

  const pushQuadratic = (caption: string, count: number, stats: ReturnType<typeof fitQuadratic>) => {
    csvLines.push([
      caption,
      "quadratic",
      count,
      format(stats.mae),
      format(stats.rmse),
      format(stats.r2),
      format(stats.b),
      format(stats.a),
      format(stats.c),
      "",
      "",
      "",
      "",
      "",
    ].join(","));
  };

  const pushPiecewise = (caption: string, count: number, stats: ReturnType<typeof fitPiecewise>) => {
    csvLines.push([
      caption,
      "piecewise",
      count,
      format(stats.mae),
      format(stats.rmse),
      format(stats.r2),
      "",
      "",
      "",
      format(stats.threshold),
      format(stats.left.slope),
      format(stats.left.intercept),
      format(stats.right.slope),
      format(stats.right.intercept),
    ].join(","));
  };

  for (const row of [...captionResults, totalResult]) {
    pushLinear(row.caption, row.count, row.linear);
    pushQuadratic(row.caption, row.count, row.quadratic);
    pushPiecewise(row.caption, row.count, row.piecewise);
  }

  fs.writeFileSync(args.outputCsv, csvLines.join("\n"));

  console.log(`Baseline regression saved to ${args.outputJson} and ${args.outputCsv}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
