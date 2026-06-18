// scripts/buildShowAggregatesV7.ts
// Precompute show-level averages and std deviations for V7 comparative vectors.
// Usage: npx tsx scripts/buildShowAggregatesV7.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { queryAllCompetitionsChronological } from "../src/mlQueries.ts";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Cleaning up show_aggregates_v7...");
  yield* (sql`DELETE FROM show_aggregates_v7`);

  console.log("Fetching competitions...");
  const competitions = yield* (queryAllCompetitionsChronological());
  console.log(`Processing ${competitions.length} shows...`);

  let count = 0;
  for (const comp of competitions) {
    const scores = yield* (sql<{
      total_score: number,
      ge1: number, ge2: number, vp: number, va: number, cg: number, mb: number, ma: number, mp: number
    }>`
      SELECT 
        cs.total_score,
        MAX(CASE WHEN js.caption_name = 'GE1' THEN js.score ELSE 0 END) as ge1,
        MAX(CASE WHEN js.caption_name = 'GE2' THEN js.score ELSE 0 END) as ge2,
        MAX(CASE WHEN js.caption_name = 'VP' THEN js.score ELSE 0 END) as vp,
        MAX(CASE WHEN js.caption_name = 'VA' THEN js.score ELSE 0 END) as va,
        MAX(CASE WHEN js.caption_name = 'CG' THEN js.score ELSE 0 END) as cg,
        MAX(CASE WHEN js.caption_name = 'MB' THEN js.score ELSE 0 END) as mb,
        MAX(CASE WHEN js.caption_name = 'MA' THEN js.score ELSE 0 END) as ma,
        MAX(CASE WHEN js.caption_name = 'MP' THEN js.score ELSE 0 END) as mp
      FROM corps_scores cs
      JOIN judge_scores js ON js.competition_slug = cs.competition_slug AND js.corps_key = cs.corps_key
      WHERE cs.competition_slug = ${comp.slug}
      GROUP BY cs.corps_key
    `);

    if (scores.length === 0) continue;

    const totals = scores.map(s => s.total_score);
    const avgTotal = mean(totals);
    const stdTotal = std(totals);

    const aggregates = {
      competition_slug: comp.slug,
      avg_total: avgTotal,
      std_total: stdTotal,
      avg_ge1: mean(scores.map(s => s.ge1)),
      avg_ge2: mean(scores.map(s => s.ge2)),
      avg_vp: mean(scores.map(s => s.vp)),
      avg_va: mean(scores.map(s => s.va)),
      avg_cg: mean(scores.map(s => s.cg)),
      avg_ma: mean(scores.map(s => s.ma)),
      avg_mb: mean(scores.map(s => s.mb)),
      avg_mp: mean(scores.map(s => s.mp)),
      field_size: scores.length,
      created_at: new Date().toISOString()
    };

    yield* (sql`INSERT INTO show_aggregates_v7 ${sql.insert(aggregates)}`);

    count++;
    if (count % 100 === 0) {
      console.log(`Processed ${count} / ${competitions.length} shows...`);
    }
  }

  console.log("Show aggregates complete.");
});

function mean(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (values.length - 1));
}

// Set up layer
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("Done!");
  })
  .catch((err) => {
    console.error("Failed to build show aggregates:", err);
    process.exitCode = 1;
  });
