import { createClient } from "@libsql/client";
import * as fs from "node:fs";

const EXPECTED_SEQ_LEN = 15;
const EXPECTED_STEP_LEN = 57;
const EXPECTED_STATIC_LEN = 53;
const PADDING_INDEX = 3;
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const RESIDUAL_OUTLIER = 2.5;
const CAPTION_SCORE_MAX = 30;
const TOTAL_SCORE_MAX = 100;

type Row = {
  season: string;
  split: string;
  x_sequence_json: string;
  x_static_json: string;
  y_residuals_json: string;
  y_recap_json: string;
};

type CurveSummary = {
  monotonicIssues: number;
  missingValues: number;
};

function checkReferenceCurves(): CurveSummary {
  const raw = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8")) as {
    curves?: Record<string, Record<string, number>>;
  };
  const curves = raw.curves ?? {};
  const byRank = new Map<number, Array<{ pct: number; values: Record<string, number> }>>();

  for (const [key, values] of Object.entries(curves)) {
    const [rankStr, pctStr] = key.split("-");
    const rank = Number(rankStr);
    const pct = Number(pctStr);
    if (!Number.isFinite(rank) || !Number.isFinite(pct)) continue;
    const list = byRank.get(rank) ?? [];
    list.push({ pct, values });
    byRank.set(rank, list);
  }

  let monotonicIssues = 0;
  let missingValues = 0;

  for (const entries of byRank.values()) {
    entries.sort((a, b) => a.pct - b.pct);
    for (const caption of CAPTIONS) {
      let last = -Infinity;
      for (const entry of entries) {
        const value = entry.values[caption];
        if (!Number.isFinite(value)) {
          missingValues += 1;
          continue;
        }
        if (value + 1e-6 < last) {
          monotonicIssues += 1;
          break;
        }
        last = value;
      }
    }
  }

  return { monotonicIssues, missingValues };
}

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });

  const result = await client.execute({
    sql: `
      SELECT season, split, x_sequence_json, x_static_json, y_residuals_json, y_recap_json
      FROM ml_sequence_rows_v5
    `,
  });

  const rows = result.rows as unknown as Row[];
  client.close();

  if (!rows.length) {
    throw new Error("No rows found in ml_sequence_rows_v5.");
  }

  const bySplit = new Map<string, number>();
  const bySeason = new Map<string, number>();

  const curveSummary = checkReferenceCurves();

  let invalidSeqLength = 0;
  let invalidStepLength = 0;
  let invalidStaticLength = 0;
  let paddingMismatch = 0;
  let nonFiniteSeq = 0;
  let nonFiniteStatic = 0;
  let nonFiniteResiduals = 0;
  let nonFiniteRecaps = 0;
  let residualOutliers = 0;
  let captionScoreOutliers = 0;
  let totalScoreOutliers = 0;

  const residualSum: Record<(typeof CAPTIONS)[number], number> = {} as Record<(typeof CAPTIONS)[number], number>;
  const residualCount: Record<(typeof CAPTIONS)[number], number> = {} as Record<(typeof CAPTIONS)[number], number>;
  for (const caption of CAPTIONS) {
    residualSum[caption] = 0;
    residualCount[caption] = 0;
  }

  for (const row of rows) {
    bySplit.set(row.split, (bySplit.get(row.split) ?? 0) + 1);
    bySeason.set(row.season, (bySeason.get(row.season) ?? 0) + 1);

    const seq = JSON.parse(row.x_sequence_json) as number[][];
    const stat = JSON.parse(row.x_static_json) as number[];
    const residuals = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const recap = JSON.parse(row.y_recap_json) as Record<string, number>;

    if (seq.length !== EXPECTED_SEQ_LEN) invalidSeqLength += 1;
    if (stat.length !== EXPECTED_STATIC_LEN) invalidStaticLength += 1;

    if (seq.some((step) => step.some((value) => !Number.isFinite(value)))) nonFiniteSeq += 1;
    if (stat.some((value) => !Number.isFinite(value))) nonFiniteStatic += 1;

    let recapTotal = 0;
    for (const caption of CAPTIONS) {
      const residual = residuals[caption];
      if (!Number.isFinite(residual)) {
        nonFiniteResiduals += 1;
      } else {
        residualSum[caption] += residual;
        residualCount[caption] += 1;
        if (Math.abs(residual) > RESIDUAL_OUTLIER) residualOutliers += 1;
      }

      const score = recap[caption];
      if (!Number.isFinite(score)) {
        nonFiniteRecaps += 1;
      } else {
        recapTotal += score;
        if (score < 0 || score > CAPTION_SCORE_MAX) captionScoreOutliers += 1;
      }
    }

    if (recapTotal > TOTAL_SCORE_MAX || recapTotal < 0) totalScoreOutliers += 1;

    for (const step of seq) {
      if (step.length !== EXPECTED_STEP_LEN) {
        invalidStepLength += 1;
        continue;
      }
      const isPadding = step[PADDING_INDEX] === 1;
      const hasSignal = step.some((value, idx) => idx !== PADDING_INDEX && value !== 0);
      if (isPadding && hasSignal) paddingMismatch += 1;
      if (!isPadding && !hasSignal) paddingMismatch += 1;
    }
  }

  console.log("Sequence validation summary (v5)");
  console.log("-------------------------------");
  console.log(`Total rows: ${rows.length}`);
  console.log("By split:");
  for (const [split, count] of Array.from(bySplit.entries()).sort()) {
    console.log(`  ${split}: ${count}`);
  }
  console.log("By season:");
  for (const [season, count] of Array.from(bySeason.entries()).sort()) {
    console.log(`  ${season}: ${count}`);
  }
  console.log("-------------------------------");
  console.log(`Rows with invalid sequence length: ${invalidSeqLength}`);
  console.log(`Steps with invalid feature length: ${invalidStepLength}`);
  console.log(`Rows with invalid static length: ${invalidStaticLength}`);
  console.log(`Padding flag mismatches: ${paddingMismatch}`);
  console.log(`Rows with non-finite sequence values: ${nonFiniteSeq}`);
  console.log(`Rows with non-finite static values: ${nonFiniteStatic}`);
  console.log(`Rows with non-finite residuals: ${nonFiniteResiduals}`);
  console.log(`Rows with non-finite recap scores: ${nonFiniteRecaps}`);
  console.log(`Residual outliers (>|${RESIDUAL_OUTLIER}|): ${residualOutliers}`);
  console.log(`Caption score outliers (> ${CAPTION_SCORE_MAX} or < 0): ${captionScoreOutliers}`);
  console.log(`Total score outliers (> ${TOTAL_SCORE_MAX} or < 0): ${totalScoreOutliers}`);
  console.log(`Reference curve monotonicity issues: ${curveSummary.monotonicIssues}`);
  console.log(`Reference curve missing values: ${curveSummary.missingValues}`);

  console.log("Residual means by caption:");
  for (const caption of CAPTIONS) {
    const count = residualCount[caption];
    const mean = count ? residualSum[caption] / count : NaN;
    console.log(`  ${caption}: ${Number.isFinite(mean) ? mean.toFixed(4) : "N/A"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
