// ml/train/evaluateModel.ts
//
// Reports:
// - MAE on p50 overall
// - MAE by %through buckets (requires pct_through_season column in ml_training_rows)
// - Top-3 ranking accuracy per competition (derived from p50 ordering)
//
// deps:
//   npm i @tensorflow/tfjs-node better-sqlite3 zod
//
// usage:
//   ts-node ml/train/evaluateModel.ts --db ./dci-relational.db --modelDir ./models/<dir> --split test

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as tf from "@tensorflow/tfjs";
import { z } from "zod";

type NormStats = { mean: number[]; std: number[] };
type FeatureSpec = {
  version: string;
  numericOrder: Array<{ name: string; defaultValue: number; missingFlag?: string }>;
};

const RowSchema = z.object({
  split: z.enum(["train", "val", "test"]),
  x_numeric_json: z.string(),
  corps_id: z.number().int().nonnegative(),
  season_id: z.number().int().nonnegative(),
  division_id: z.number().int().nonnegative(),
  judge_ids_json: z.string().optional(),
  y_total: z.number(),
  pct_through_season: z.number().nullable().optional(),
  competition_slug: z.string(),
  corps_key: z.string().optional(),
});
type DBRow = z.infer<typeof RowSchema>;

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    db: get("--db", "./dci-relational.db")!,
    modelDir: get("--modelDir")!,
    split: (get("--split", "test") as "train" | "val" | "test")!,
    maxJudges: Number(get("--maxJudges", "16")),
    useJudges: get("--useJudges", "1") !== "0",
  };
}

function safeJsonArrayNumbers(s: string): number[] {
  const v = JSON.parse(s);
  if (!Array.isArray(v)) throw new Error("Expected JSON array");
  return v.map((x) => (typeof x === "number" ? x : Number(x)));
}

function padJudgeIds(ids: number[], maxJudges: number): number[] {
  const out = ids.slice(0, maxJudges);
  while (out.length < maxJudges) out.push(0);
  return out;
}

function applyNorm(x: number[][], stats: NormStats): number[][] {
  const d = stats.mean.length;
  return x.map((row) => {
    const out = new Array(d);
    for (let j = 0; j < d; j++) out[j] = (row[j]! - stats.mean[j]!) / stats.std[j]!;
    return out;
  });
}

const SQL = `
  SELECT
    split,
    x_numeric_json,
    corps_id,
    season_id,
    division_id,
    judge_ids_json,
    y_total,
    pct_through_season,
    competition_slug,
    corps_key
  FROM ml_training_rows
  WHERE y_total IS NOT NULL
`;

async function main() {
  const args = parseArgs();
  if (!args.modelDir) throw new Error("--modelDir is required");

  const norm = JSON.parse(fs.readFileSync(path.join(args.modelDir, "numeric_norm.json"), "utf8")) as NormStats;
  const featureSpec = JSON.parse(fs.readFileSync(path.join(args.modelDir, "features.json"), "utf8")) as FeatureSpec;
  void featureSpec; // not strictly required for eval, but useful for sanity checks

  const model = await tf.loadLayersModel(`file://${path.join(args.modelDir, "model.json")}`);

  const db = new Database(args.db, { readonly: true });
  const rowsAll = db.prepare(SQL).all().map((row: unknown) => RowSchema.parse(row)) as DBRow[];

  db.close();

  const rows = rowsAll.filter((r) => r.split === args.split);
  if (!rows.length) throw new Error(`No rows for split=${args.split}`);

  // Build tensors
  const xNumeric = rows.map((r) => safeJsonArrayNumbers(r.x_numeric_json));
  const xNorm = applyNorm(xNumeric, norm);
  const xNumericT = tf.tensor2d(xNorm, [xNorm.length, xNorm[0]!.length], "float32");
  const corpsT = tf.tensor2d(rows.map((r) => [r.corps_id]), [rows.length, 1], "int32");
  const seasonT = tf.tensor2d(rows.map((r) => [r.season_id]), [rows.length, 1], "int32");
  const divisionT = tf.tensor2d(rows.map((r) => [r.division_id]), [rows.length, 1], "int32");
  const yTrue = tf.tensor2d(rows.map((r) => [r.y_total]), [rows.length, 1], "float32");

  let inputs: tf.Tensor[] = [xNumericT, corpsT, seasonT, divisionT];

  if (args.useJudges) {
    const judgeIds = rows.map((r) =>
      padJudgeIds(r.judge_ids_json ? safeJsonArrayNumbers(r.judge_ids_json).map((n) => Math.trunc(n)) : [], args.maxJudges)
    );
    const judgeT = tf.tensor2d(judgeIds, [rows.length, args.maxJudges], "int32");
    inputs = [...inputs, judgeT];
  }

  const yPred = model.predict(inputs) as tf.Tensor2D; // [N,3]
  const p50 = yPred.slice([0, 1], [-1, 1]); // [N,1]

  const absErr = tf.abs(tf.sub(yTrue, p50));
  const mae = (await tf.mean(absErr).array()) as number;

  // MAE by pct-through buckets
  // Buckets: [0-10), [10-20), ... [90-100+)
  const bucketSums = new Array(10).fill(0);
  const bucketCounts = new Array(10).fill(0);

  const p50Arr = (await p50.array()) as number[][];
  const yArr = (await yTrue.array()) as number[][];
  for (let i = 0; i < rows.length; i++) {
    const pct = rows[i]!.pct_through_season;
    if (pct == null || !Number.isFinite(pct)) continue;
    const b = Math.max(0, Math.min(9, Math.floor(pct / 10)));
    const e = Math.abs(yArr[i]![0]! - p50Arr[i]![0]!);
    bucketSums[b]! += e;
    bucketCounts[b]! += 1;
  }

  // Top-3 ranking accuracy by competition
  // For each competition_slug (and division_id), compare predicted ordering vs actual ordering.
  type Key = string;
  type Item = { actual: number; pred: number; corpsId: number; corpsKey?: string };
  const groups = new Map<Key, Item[]>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const key = `${r.competition_slug}::div=${r.division_id}`;
    const list = groups.get(key) ?? [];
    list.push({ actual: r.y_total, pred: p50Arr[i]![0]!, corpsId: r.corps_id, corpsKey: r.corps_key });
    groups.set(key, list);
  }

  let top3ExactOrderHits = 0;
  let top3SetHits = 0;
  let top3Events = 0;

  for (const [, items] of groups) {
    if (items.length < 3) continue;
    top3Events += 1;

    const actualTop = [...items].sort((a, b) => b.actual - a.actual).slice(0, 3);
    const predTop = [...items].sort((a, b) => b.pred - a.pred).slice(0, 3);

    const actualIds = actualTop.map((x) => x.corpsId);
    const predIds = predTop.map((x) => x.corpsId);

    // Exact order accuracy for top-3
    const exact = actualIds.every((id, idx) => predIds[idx] === id);
    if (exact) top3ExactOrderHits += 1;

    // Set overlap accuracy (how many of the actual top3 are in predicted top3)
    const actualSet = new Set(actualIds);
    const overlap = predIds.reduce((acc, id) => acc + (actualSet.has(id) ? 1 : 0), 0);
    top3SetHits += overlap; // out of 3 per event
  }

  console.log(`Split: ${args.split}`);
  console.log(`Rows: ${rows.length}`);
  console.log(`MAE (p50): ${mae.toFixed(4)}`);

  console.log("\nMAE by %through buckets (only rows with pct_through_season present):");
  for (let b = 0; b < 10; b++) {
    const lo = b * 10;
    const hi = b === 9 ? 100 : (b + 1) * 10;
    const n = bucketCounts[b]!;
    const v = n ? bucketSums[b]! / n : NaN;
    console.log(`  [${lo}, ${hi})  n=${n}  mae=${Number.isFinite(v) ? v.toFixed(4) : "NA"}`);
  }

  console.log("\nTop-3 ranking accuracy (per competition_slug, per division):");
  console.log(`  events=${top3Events}`);
  console.log(`  exact-order top3 accuracy: ${(top3ExactOrderHits / Math.max(1, top3Events)).toFixed(4)}`);
  console.log(`  top3 set overlap (avg of 3): ${(top3SetHits / Math.max(1, top3Events) / 3).toFixed(4)}`);

  tf.dispose([yPred, p50, absErr, xNumericT, corpsT, seasonT, divisionT, yTrue, ...inputs]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
