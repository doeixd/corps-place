import { createClient } from "@libsql/client";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const RESIDUAL_OFFSET = 14;
const CAPTION_STRIDE = 4;
const EMA_ALPHA = 0.3;
const IS_PADDING_INDEX = 3;

type Caption = (typeof CAPTIONS)[number];

type Row = {
  x_sequence_json: string;
  y_residuals_json: string;
};

type OutputFile = {
  baseline: string;
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
    db: get("--db", "./dci-relational.db")!,
    split: get("--split", "val")!,
    baseline: get("--baseline", "baseline_ema")!,
    out: get("--out", "./baseline-errors.json")!,
  };
}

function isRealStep(step: number[]) {
  return step[IS_PADDING_INDEX] !== 1;
}

function getResidual(step: number[], captionIndex: number): number {
  return step[RESIDUAL_OFFSET + captionIndex * CAPTION_STRIDE] ?? 0;
}

function buildHistory(seq: number[][]): Record<Caption, number[]> {
  const history = {} as Record<Caption, number[]>;
  for (const caption of CAPTIONS) history[caption] = [];

  for (const step of seq) {
    if (!isRealStep(step)) continue;
    CAPTIONS.forEach((caption, idx) => {
      history[caption].push(getResidual(step, idx));
    });
  }

  return history;
}

function predictLast(history: number[]): number {
  return history.length ? history[history.length - 1]! : 0;
}

function predictEMA(history: number[]): number {
  let ema = 0;
  for (const value of history) {
    ema = EMA_ALPHA * value + (1 - EMA_ALPHA) * ema;
  }
  return ema;
}

function predictLinear(history: number[]): number {
  if (history.length === 0) return 0;
  if (history.length === 1) return history[0]!;

  const window = history.slice(Math.max(0, history.length - 3));
  const n = window.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += window[i]!;
    sumXY += i * window[i]!;
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return window[n - 1]!;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return intercept + slope * n;
}

async function main() {
  const args = parseArgs();

  const baselineFns: Record<string, (history: number[]) => number> = {
    baseline_zero: () => 0,
    baseline_last: predictLast,
    baseline_ema: predictEMA,
    baseline_lr: predictLinear,
  };

  const baselineFn = baselineFns[args.baseline];
  if (!baselineFn) {
    throw new Error(`Unknown baseline ${args.baseline}`);
  }

  const client = createClient({ url: `file:${args.db}` });
  const result = await client.execute({
    sql: `
      SELECT x_sequence_json, y_residuals_json
      FROM ml_sequence_rows_v5
      WHERE split = ?
      ORDER BY competition_date ASC
    `,
    args: [args.split],
  });
  const rows = result.rows as unknown as Row[];
  client.close();

  if (!rows.length) {
    throw new Error(`No rows found for split=${args.split}`);
  }

  const errors: number[] = [];
  const absErrors: number[] = [];

  for (const row of rows) {
    const seq = JSON.parse(row.x_sequence_json) as number[][];
    const residuals = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const history = buildHistory(seq);

    for (const caption of CAPTIONS) {
      const actual = residuals[caption] ?? 0;
      const predicted = baselineFn(history[caption]);
      const error = predicted - actual;
      errors.push(error);
      absErrors.push(Math.abs(error));
    }
  }

  const output: OutputFile = {
    baseline: args.baseline,
    errors,
    absErrors,
  };

  await import("node:fs").then((fs) => {
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  });
  console.log(`Wrote ${errors.length} errors to ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
