// scripts/verifyV9Data.ts
import { createClient } from "@libsql/client";
import * as fs from "node:fs";

const DB_PATH = "./dci-relational.db";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

async function verify() {
  const client = createClient({ url: `file:${DB_PATH}` });

  console.log("--- V9 Subcaption Data Audit ---");

  // 1. Basic Counts and Split Distribution
  const counts = await client.execute(`
    SELECT split, COUNT(*) as count 
    FROM ml_sequence_rows_v9_subcaption 
    GROUP BY split
  `);

  console.log("\n[Split Distribution]");
  const totalRows = counts.rows.reduce((acc, r: any) => acc + Number(r.count), 0);
  for (const row of counts.rows) {
    const pct = ((Number(row.count) / totalRows) * 100).toFixed(1);
    console.log(`  ${row.split}: ${row.count} (${pct}%)`);
  }
  console.log(`  Total: ${totalRows}`);

  // 2. Sample Data Verification
  console.log("\n[Sampling and Range Checks]");
  const samples = await client.execute(`
    SELECT season, competition_date, corps_key, y_recap_json, x_sequence_json, x_static_json
    FROM ml_sequence_rows_v9_subcaption
    LIMIT 500
  `);

  let recapAnomalies = 0;
  let sequenceLeakage = 0;
  let staticOutliers = 0;

  for (const row of samples.rows as any[]) {
    const recap = JSON.parse(row.y_recap_json);
    const seq = JSON.parse(row.x_sequence_json);
    const stat = JSON.parse(row.x_static_json);

    // Range checks for target recaps
    for (const cap of CAPTIONS) {
      const val = recap[cap] ?? 0;
      if (val < 0 || val > 20) {
        recapAnomalies++;
        if (recapAnomalies <= 5) console.error(`  CRITICAL: Recap out of range for ${row.corps_key}: ${cap}=${val}`);
      }
    }

    // Sequence Alignment/Padding check
    if (!Array.isArray(seq) || seq.length !== 15) {
      console.error(`  ERROR: Invalid sequence length for ${row.corps_key}: ${seq.length}`);
    }

    // Basic leakage check: Does the sequence contain non-zero data at the same date as the show?
    // In buildMlSequencesV9, pastShows are sliced 0 to i, so show i is NOT included.
    // However, if there's an error in competition_date sorting, we might leak.
    // This is hard to verify without full DB context but we can check if sequence values look like current values.
    // We'll skip deep leakage check for now but keep as placeholder if needed.

    // Static outlier check (e.g. 0 means missing usually, or huge values)
    if (stat.some((v: number) => isNaN(v) || !isFinite(v))) {
      staticOutliers++;
    }

    // Temporal Leakage check
    for (const step of seq) {
      if (step[3] === 0) { // If not padding
        const daysSince = step[1];
        // Index 1 is daysSince (Math.min(MlQueries.daysBetween(prevShow.date, show.date), 14) / 14)
        // This should always be >= 0
        if (daysSince < 0) {
          sequenceLeakage++;
          if (sequenceLeakage <= 5) console.error(`  CRITICAL: Negative daysSince in sequence for ${row.corps_key}: ${daysSince}`);
        }
      }
    }
  }

  if (recapAnomalies === 0) console.log("  âœ… Recap ranges verified (0-20)");
  if (staticOutliers === 0) console.log("  âœ… Static features look sane");
  if (sequenceLeakage === 0) console.log("  âœ… Temporal logic verified (no negative gaps)");

  // 3. History Poisoning - More specialized check
  // Check if any row has GE1 > 0 in its padding steps
  console.log("\n[Padding Integrity and Potential Leakage]");
  let leakyRows = 0;
  for (const row of samples.rows as any[]) {
    const seq = JSON.parse(row.x_sequence_json) as number[][];
    // PADDING_INDEX = 3. If bit 3 is set, it's padding.
    // In buildMlSequencesV9: padding[3] = 1;
    for (const step of seq) {
      const isPadding = step[3] === 1;
      if (isPadding) {
        // If it's padding, features should be zero (mostly)
        // RECAP_OFFSET_IN_FEATS = 21
        const ge1_res = step[21] ?? 0;
        if (ge1_res !== 0) {
          leakyRows++;
          if (leakyRows <= 5) console.warn(`  WARNING: Non-zero recap residual in padding for ${row.corps_key}`);
        }
      }
    }
  }
  if (leakyRows === 0) console.log("  âœ… Padding integrity verified (zeroes in masked steps)");

  client.close();
  console.log("\nAudit Complete.");
}

verify().catch(console.error);
