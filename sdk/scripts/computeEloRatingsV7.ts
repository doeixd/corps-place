// scripts/computeEloRatingsV7.ts
// Compute historical Elo ratings for judges and corps.
// Usage: npx tsx scripts/computeEloRatingsV7.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { queryAllCompetitionsChronological, queryJudgeScoresForCompetition } from "../src/mlQueries.ts";

const INITIAL_ELO = 1500;
const INITIAL_CONFIDENCE = 50;
const K_FACTOR_NEW = 32;
const K_FACTOR_STABLE = 16;
const CONFIDENCE_THRESHOLD = 20;
const CONFIDENCE_DECAY = 0.95;
const MAX_SCORE = 20;

interface EloState {
  elo: number;
  confidence: number;
  numScores: number;
}

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Cleaning up existing Elo data...");
  yield* (sql`DELETE FROM judge_elo_history`);
  yield* (sql`DELETE FROM corps_elo_history`);
  yield* (sql`DELETE FROM judge_elo_ratings`);
  yield* (sql`DELETE FROM corps_elo_ratings`);

  console.log("Fetching competitions...");
  const competitions = yield* (queryAllCompetitionsChronological());
  console.log(`Processing ${competitions.length} competitions chronologically...`);

  const judgeEloMap = new Map<string, EloState>();
  const corpsEloMap = new Map<string, EloState>();

  const judgeHistory: any[] = [];
  const corpsHistory: any[] = [];

  let count = 0;
  for (const comp of competitions) {
    const scores = yield* (queryJudgeScoresForCompetition(comp.slug));

    for (const score of scores) {
      const judgeKey = `${score.judge_id}:${comp.season}:${score.caption_name}`;
      const corpsKey = `${score.corps_key}:${comp.season}:${score.caption_name}`;

      const jState = judgeEloMap.get(judgeKey) || { elo: INITIAL_ELO, confidence: INITIAL_CONFIDENCE, numScores: 0 };
      const cState = corpsEloMap.get(corpsKey) || { elo: INITIAL_ELO, confidence: INITIAL_CONFIDENCE, numScores: 0 };

      // Elo Algorithm
      const expected = 1 / (1 + Math.exp(-(cState.elo - jState.elo) / 400));
      const actual = score.score / MAX_SCORE;

      const kJudge = jState.numScores < CONFIDENCE_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_STABLE;
      const kCorps = cState.numScores < CONFIDENCE_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_STABLE;

      const delta = actual - expected;

      const jEloBefore = jState.elo;
      const cEloBefore = cState.elo;

      jState.elo += kJudge * delta;
      cState.elo += kCorps * delta;

      jState.confidence *= CONFIDENCE_DECAY;
      cState.confidence *= CONFIDENCE_DECAY;

      jState.numScores++;
      cState.numScores++;

      judgeEloMap.set(judgeKey, jState);
      corpsEloMap.set(corpsKey, cState);

      const dateStr = (comp.competition_date as any) instanceof Date
        ? (comp.competition_date as any).toISOString()
        : String(comp.competition_date);

      judgeHistory.push({
        judge_id: score.judge_id,
        season: comp.season,
        competition_slug: comp.slug,
        caption_name: score.caption_name,
        elo_before: jEloBefore,
        elo_after: jState.elo,
        updated_at: dateStr
      });

      corpsHistory.push({
        corps_key: score.corps_key,
        season: comp.season,
        competition_slug: comp.slug,
        caption_name: score.caption_name,
        elo_before: cEloBefore,
        elo_after: cState.elo,
        competition_date: dateStr
      });
    }

    if (judgeHistory.length > 1000) {
      yield* (flushHistory(sql, judgeHistory, corpsHistory));
    }

    count++;
    if (count % 100 === 0) {
      console.log(`Processed ${count} / ${competitions.length} competitions...`);
    }
  }

  yield* (flushHistory(sql, judgeHistory, corpsHistory));
  yield* (saveFinalRatings(sql, judgeEloMap, corpsEloMap));

  console.log("Elo computation complete.");
});

function flushHistory(sql: any, judgeHistory: any[], corpsHistory: any[]) {
  return Effect.gen(function* () {
    if (judgeHistory.length > 0) {
      yield* (sql`INSERT INTO judge_elo_history ${sql.insert(judgeHistory)}`);
      judgeHistory.length = 0;
    }
    if (corpsHistory.length > 0) {
      yield* (sql`INSERT INTO corps_elo_history ${sql.insert(corpsHistory)}`);
      corpsHistory.length = 0;
    }
  });
}

function saveFinalRatings(sql: any, judgeEloMap: Map<string, EloState>, corpsEloMap: Map<string, EloState>) {
  return Effect.gen(function* () {
    console.log("Saving final ratings...");

    const judgeRatings: any[] = [];
    for (const [key, state] of judgeEloMap) {
      const [id, season, caption] = key.split(":");
      judgeRatings.push({
        judge_id: id,
        season,
        caption_name: caption,
        elo_rating: state.elo,
        confidence: state.confidence,
        num_scores: state.numScores,
        last_updated: new Date().toISOString()
      });
      if (judgeRatings.length > 500) {
        yield* (sql`INSERT INTO judge_elo_ratings ${sql.insert(judgeRatings)}`);
        judgeRatings.length = 0;
      }
    }
    if (judgeRatings.length > 0) {
      yield* (sql`INSERT INTO judge_elo_ratings ${sql.insert(judgeRatings)}`);
    }

    const corpsRatings: any[] = [];
    for (const [key, state] of corpsEloMap) {
      const [id, season, caption] = key.split(":");
      corpsRatings.push({
        corps_key: id,
        season,
        caption_name: caption,
        elo_rating: state.elo,
        confidence: state.confidence,
        num_shows: state.numScores,
        last_updated: new Date().toISOString()
      });
      if (corpsRatings.length > 500) {
        yield* (sql`INSERT INTO corps_elo_ratings ${sql.insert(corpsRatings)}`);
        corpsRatings.length = 0;
      }
    }
    if (corpsRatings.length > 0) {
      yield* (sql`INSERT INTO corps_elo_ratings ${sql.insert(corpsRatings)}`);
    }
  });
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
    console.error("Elo computation failed:", err);
    process.exitCode = 1;
  });
