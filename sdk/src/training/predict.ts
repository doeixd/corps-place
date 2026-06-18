// ml/serve/predict.ts
//
// CLI that:
// - loads model artifacts (model.json, numeric_norm.json, features.json)
// - accepts an event lineup JSON (partial data allowed)
// - outputs p10/p50/p90 + derived ranking (sorted by p50)
//
// deps:
//   npm i @tensorflow/tfjs-node
//
// example usage:
//   ts-node ml/serve/predict.ts --modelDir ./models/<dir> --lineup ./lineup.json
//
// lineup.json format:
// {
//   "useJudges": true,
//   "maxJudges": 16,
//   "entries": [
//     {
//       "corpsId": 12,
//       "seasonId": 9,
//       "divisionId": 1,
//       "judgeIds": [5, 9, 11],
//       "numeric": { "pctThroughSeason": 42, "daysSinceLastShow": 3, "has_lastScoreTotal": 1, "lastScoreTotal": 80.2 }
//     }
//   ]
// }

import * as fs from "node:fs";
import { createClient } from "@libsql/client";
import { applyBayesianAdjustment } from "../bayesianAdjustmentV5.js";
import { loadDciModel, PredictInput } from "./loadModel.js";


function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    modelDir: get("--modelDir")!,
    lineup: get("--lineup")!,
    bayesian: argv.includes("--bayesian"),
    db: get("--db", "./dci-relational.db")!,
  };
}

type LineupEntry = PredictInput & {
  corpsKey?: string;
  season?: string;
};

type LineupFile = {
  useJudges?: boolean;
  maxJudges?: number;
  entries: LineupEntry[];
  // optional display labels:
  labels?: Record<number, string>; // corpsId -> name
};


function clampQuantiles(o: { p10: number; p50: number; p90: number }) {
  // Enforce p10 <= p50 <= p90
  let { p10, p50, p90 } = o;
  if (p10 > p50) [p10, p50] = [p50, p10];
  if (p50 > p90) [p50, p90] = [p90, p50];
  if (p10 > p50) [p10, p50] = [p50, p10];
  return { p10, p50, p90 };
}

async function getBayesianAdjustment(dbPath: string, corpsKey: string, season: string) {
  const client = createClient({ url: `file:${dbPath}` });
  const result = await client.execute({
    sql: `
      SELECT mean_error, error_variance
      FROM corps_bayesian_adjustments_v5
      WHERE corps_key = ? AND season = ?
    `,
    args: [corpsKey, season],
  });
  client.close();

  const rows = result.rows as unknown as Array<{ mean_error: number; error_variance: number }>;
  if (!rows.length) {
    return { meanAdjustment: 0, uncertainty: 1 };
  }

  const meanAdjustment = rows.reduce((sum, row) => sum + row.mean_error, 0) / rows.length;
  const varianceMean = rows.reduce((sum, row) => sum + row.error_variance, 0) / rows.length;
  return { meanAdjustment, uncertainty: Math.sqrt(varianceMean) };
}


async function main() {
  const args = parseArgs();
  if (!args.modelDir) throw new Error("--modelDir is required");
  if (!args.lineup) throw new Error("--lineup is required");

  const lineup = JSON.parse(fs.readFileSync(args.lineup, "utf8")) as LineupFile;
  const useJudges = lineup.useJudges ?? true;
  const maxJudges = lineup.maxJudges ?? 16;

  const loaded = await loadDciModel(args.modelDir, { useJudges, maxJudges });
  const preds = await loaded.predictBatch(lineup.entries);

  const ranked = [] as Array<LineupEntry & { label: string; p10: number; p50: number; p90: number }>;

  for (let i = 0; i < lineup.entries.length; i++) {
    const entry = lineup.entries[i]!;
    let q = clampQuantiles(preds[i]!);
    if (args.bayesian && entry.corpsKey && entry.season) {
      const adjustment = await getBayesianAdjustment(args.db, entry.corpsKey, entry.season);
      q = clampQuantiles(applyBayesianAdjustment(q, adjustment));
    }
    const label = lineup.labels?.[entry.corpsId] ?? `corpsId=${entry.corpsId}`;
    ranked.push({ ...entry, label, ...q });
  }


  ranked.sort((a, b) => b.p50 - a.p50);

  // Pretty output
  const rows = ranked.map((r, idx) => ({
    rank: idx + 1,
    corps: r.label,
    p50: Number(r.p50.toFixed(3)),
    p10: Number(r.p10.toFixed(3)),
    p90: Number(r.p90.toFixed(3)),
  }));

  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
