import { createClient } from "@libsql/client";
import * as fs from "node:fs";

// Constants from trainModelV8.ts
const DB_PATH = "./dci-relational.db";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("Querying ML Sequence Rows...");

  // Select residuals and recap
  const result = await client.execute(`
    SELECT corps_key, season, y_residuals_json, y_recap_json
    FROM ml_sequence_rows_v7
  `);

  const rows = result.rows as unknown as Array<{
    corps_key: string;
    season: string;
    y_residuals_json: string;
    y_recap_json: string;
  }>;

  console.log(`Found ${rows.length} rows.`);

  // Initialize stats containers
  const stats = CAPTIONS.map(c => ({
    name: c,
    residualValues: [] as number[],
    recapValues: [] as number[],
    zeroCount: 0,
    nullCount: 0,
  }));

  for (const row of rows) {
    let resids: Record<string, number>;
    let recap: Record<string, number>;
    try {
      resids = JSON.parse(row.y_residuals_json);
      recap = JSON.parse(row.y_recap_json);
    } catch (e) {
      console.warn("JSON parse error", e);
      continue;
    }

    CAPTIONS.forEach((cap, idx) => {
      const rVal = resids[cap];
      const recVal = recap[cap];

      if (rVal === undefined || rVal === null) {
        stats[idx].nullCount++;
      } else {
        stats[idx].residualValues.push(rVal);
      }

      if (recVal !== undefined && recVal !== null) {
        stats[idx].recapValues.push(recVal);
        if (recVal === 0) stats[idx].zeroCount++;
      }
    });
  }

  // Compute summary stats
  console.log("\n--- Caption Statistics ---");
  for (const stat of stats) {
    const rVals = stat.residualValues;
    const recVals = stat.recapValues;

    // Sort for percentiles
    rVals.sort((a, b) => a - b);
    recVals.sort((a, b) => a - b);

    const min = rVals[0];
    const max = rVals[rVals.length - 1];
    const mean = rVals.reduce((a, b) => a + b, 0) / rVals.length;

    // StdDev
    const variance = rVals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / rVals.length;
    const std = Math.sqrt(variance);

    // Outliers (> 3 std from mean?)
    const lowOutlier = mean - 4 * std;
    const highOutlier = mean + 4 * std;
    const outliers = rVals.filter(v => v < lowOutlier || v > highOutlier);

    // Recap stats
    const recMin = recVals[0];
    const recMax = recVals[recVals.length - 1];
    const recMean = recVals.reduce((a, b) => a + b, 0) / recVals.length;

    console.log(`\nCaption: ${stat.name}`);
    console.log(`  Residuals -> Mean: ${mean.toFixed(3)}, Std: ${std.toFixed(3)}, Min: ${min?.toFixed(3)}, Max: ${max?.toFixed(3)}`);
    console.log(`  Recap     -> Mean: ${recMean.toFixed(3)}, Min: ${recMin?.toFixed(3)}, Max: ${recMax?.toFixed(3)}`);
    console.log(`  Zeros: ${stat.zeroCount}, Nulls: ${stat.nullCount}, Count: ${rVals.length}`);
    if (outliers.length > 0) {
      console.log(`  WARNING: ${outliers.length} extreme residuals (>4 sigma)! Examples: ${outliers.slice(0, 5).join(", ")} ... ${outliers.slice(-5).join(", ")}`);
    } else {
      console.log(`  No extreme residuals (>4 sigma).`);
    }
  }

  client.close();
}

main().catch(console.error);
