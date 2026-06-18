import { createClient } from "@libsql/client";
import * as fs from "node:fs";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const RESIDUAL_OFFSET = 14;
const CAPTION_STRIDE = 4;
const PADDING_INDEX = 3;

type Caption = (typeof CAPTIONS)[number];

type Row = {
  season: string;
  split: string;
  corps_key: string;
  competition_slug: string;
  x_sequence_json: string;
  x_static_json: string;
  y_residuals_json: string;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    db: get("--db", "./dci-relational.db")!,
    out: get("--out", "./xgboost-features-v5.csv")!,
    split: get("--split"),
  };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function slope(values: number[]) {
  if (values.length < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < values.length; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = values.length * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (values.length * sumXY - sumX * sumY) / denom;
}

function getResidual(step: number[], captionIndex: number): number {
  return step[RESIDUAL_OFFSET + captionIndex * CAPTION_STRIDE] ?? 0;
}

function getSteps(seq: number[][]) {
  return seq.filter((step) => step[PADDING_INDEX] !== 1);
}

function getRankFromStep(step: number[]) {
  const rankNorm = step[8] ?? 0;
  return rankNorm * 25;
}

async function main() {
  const args = parseArgs();

  const client = createClient({ url: `file:${args.db}` });
  const result = await client.execute({
    sql: `
      SELECT season, split, corps_key, competition_slug, x_sequence_json, x_static_json, y_residuals_json
      FROM ml_sequence_rows_v5
      ${args.split ? "WHERE split = ?" : ""}
    `,
    args: args.split ? [args.split] : [],
  });
  const rows = result.rows as unknown as Row[];
  client.close();

  if (!rows.length) {
    throw new Error("No rows found in ml_sequence_rows_v5.");
  }

  const header: string[] = [
    "season",
    "split",
    "corps_key",
    "competition_slug",
  ];

  for (let i = 0; i < 20; i++) {
    header.push(`static_${i}`);
  }

  for (const caption of CAPTIONS) {
    header.push(`residual_3show_slope_${caption}`);
    header.push(`residual_5show_slope_${caption}`);
    header.push(`residual_acceleration_${caption}`);
  }

  header.push(
    "rank_vs_expectation",
    "ge_vs_visual_gap",
    "music_vs_visual_gap",
    "caption_consistency",
    "has_peaked",
    "improving_streak",
    "declining_streak"
  );

  for (const caption of CAPTIONS) {
    header.push(`last_residual_${caption}`);
  }

  for (const caption of CAPTIONS) {
    header.push(`target_${caption}`);
  }

  const lines: string[] = [header.join(",")];

  for (const row of rows) {
    const seq = JSON.parse(row.x_sequence_json) as number[][];
    const stat = JSON.parse(row.x_static_json) as number[];
    const residuals = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const steps = getSteps(seq);
    const lastStep = steps[steps.length - 1] ?? new Array(57).fill(0);

    const features: number[] = [];

    features.push(...stat.map((value) => (Number.isFinite(value) ? value : 0)));

    for (let i = 0; i < CAPTIONS.length; i++) {
      const history = steps.map((step) => getResidual(step, i));
      const last3 = history.slice(-3);
      const last5 = history.slice(-5);
      const slope3 = slope(last3);
      const slope5 = slope(last5);
      features.push(slope3, slope5, slope3 - slope5);
    }

    const geMean = mean([getResidual(lastStep, 0), getResidual(lastStep, 1)]);
    const visualMean = mean([getResidual(lastStep, 2), getResidual(lastStep, 3), getResidual(lastStep, 4)]);
    const musicMean = mean([getResidual(lastStep, 5), getResidual(lastStep, 6), getResidual(lastStep, 7)]);
    const captionConsistency = std(CAPTIONS.map((_, idx) => getResidual(lastStep, idx)));

    const meanResidualSeries = steps.map((step) => mean(CAPTIONS.map((_, idx) => getResidual(step, idx))));
    const bestResidual = meanResidualSeries.length ? Math.max(...meanResidualSeries) : 0;
    const bestIndex = meanResidualSeries.findIndex((value) => value === bestResidual);
    const hasPeaked = meanResidualSeries.length > 0 && meanResidualSeries.length - 1 - bestIndex >= 3 ? 1 : 0;

    let improvingStreak = 0;
    let decliningStreak = 0;
    for (let i = meanResidualSeries.length - 1; i > 0; i--) {
      const delta = meanResidualSeries[i]! - meanResidualSeries[i - 1]!;
      if (delta > 0) {
        if (decliningStreak === 0) improvingStreak += 1;
        else break;
      } else if (delta < 0) {
        if (improvingStreak === 0) decliningStreak += 1;
        else break;
      } else {
        break;
      }
    }

    const prevRankNorm = stat[0] ?? 0;
    const prevRank = prevRankNorm * 25;
    const currentRank = getRankFromStep(lastStep) || prevRank;

    features.push(
      currentRank - prevRank,
      geMean - visualMean,
      musicMean - visualMean,
      captionConsistency,
      hasPeaked,
      improvingStreak,
      decliningStreak
    );

    for (const caption of CAPTIONS) {
      features.push(getResidual(lastStep, CAPTIONS.indexOf(caption)));
    }

    for (const caption of CAPTIONS) {
      features.push(residuals[caption] ?? 0);
    }

    const rowValues = [
      row.season,
      row.split,
      row.corps_key,
      row.competition_slug,
      ...features.map((value) => Number.isFinite(value) ? value.toString() : "0"),
    ];

    lines.push(rowValues.join(","));
  }

  fs.writeFileSync(args.out, lines.join("\n"));
  console.log(`Wrote ${rows.length} rows to ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
