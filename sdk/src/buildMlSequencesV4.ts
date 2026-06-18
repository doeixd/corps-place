
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as MlQueries from "./mlQueries.js";
import * as fs from "node:fs";

// Load reference curves
const REFERENCE_CURVES = JSON.parse(
  fs.readFileSync('./src/training/referenceCurvesV4.json', 'utf-8')
);

// ----- Types -----

export interface V4SequenceRow {
  season: string;
  competition_slug: string;
  corps_key: string;
  // ... other fields
  x_sequence: number[][]; // [SeqLen, Features]
  y_residual: Record<string, number>;
}

export const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];

const CAPTION_MAP: Record<string, string> = {
  "General Effect": "GE1",
  "Visual": "VP",
  "Music": "MB",
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  "Visual Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
};

// ----- Schema Setup -----

export const ensureSequenceTablesV4 = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v4 (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER NOT NULL,
      
      x_sequence_json TEXT NOT NULL, -- [SeqLen, Features]
      y_residuals_json TEXT NOT NULL, -- Target residuals
      y_recap_json TEXT NOT NULL,     -- Raw recap for evaluation
      
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `);
});

// ----- Feature Engineering Helpers -----

function getBaseline(rank: number, pct: number, caption: string): number {
  if (rank < 1) rank = 12; // Fallback
  // Round pct to nearest 5
  const bucket = Math.round(pct / 5) * 5;
  const key = `${rank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }

  // Fallback: try rank-50 (mid season) or global avg?
  // Simple fallback for now:
  return curves[`${rank}-50`]?.[caption] || 15.0;
}

// Helper to compute slope
function computeSlope(values: number[]): number {
  if (values.length < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = (n * sumX2) - (sumX * sumX);
  if (denom === 0) return 0;
  return ((n * sumXY) - (sumX * sumY)) / denom;
}

// Helper: Normalize features
function normalizeRank(r: number) { return r / 25.0; } // Max rank 25 approx
function normalizeScore(s: number) { return (s - 75.0) / 25.0; } // Roughly 60-100 range

export const buildSequences = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureSequenceTablesV4);

  const seasons = ["2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024"];
  const division = "World Class";

  // 1. Pre-load Global Stats (e.g. Previous Season Ranks)
  const prevSeasonRanks: Record<string, Record<string, number>> = {};
  for (const season of seasons) {
    // Naive year handling, map 2022 -> 2019
    let prevYear = parseInt(season) - 1;
    if (season === "2022") prevYear = 2019;

    const raw = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevYear.toString(), division));
    // Sort to be sure
    const sortedRaw = [...raw].sort((a, b) => b.best_total - a.best_total);
    prevSeasonRanks[season] = {};
    sortedRaw.forEach((r, idx) => {
      prevSeasonRanks[season]![r.corps_key] = idx + 1;
    });
  }

  // 2. Process Each Season
  for (const season of seasons) {
    console.log(`Processing season ${season}...`);
    // Fetch all flattened caption data
    const rows = yield* (MlQueries.querySeasonCaptions(season, division));

    // Group: Corps -> Shows -> Data
    // We rely on query sorting: date, slug, corps_key
    const corpsMap = new Map<string, any[]>();

    for (const r of rows) {
      if (!corpsMap.has(r.corps_key)) corpsMap.set(r.corps_key, []);
      const shows = corpsMap.get(r.corps_key)!;

      let lastShow = shows[shows.length - 1];
      if (!lastShow || lastShow.slug !== r.slug) {
        lastShow = {
          slug: r.slug,
          date: r.date,
          percent_through: r.percent_through,
          rank: r.rank,
          total_score: r.total_score,
          captions: {}
        };
        shows.push(lastShow);
      }

      // Add caption
      const capKey = CAPTION_MAP[r.caption_name];
      if (capKey) {
        lastShow.captions[capKey] = { score: r.score, rank: r.caption_rank };
      }
    }

    // 3. Generate Sequences per Corps
    const allInserts: any[] = [];

    for (const [corpsKey, shows] of corpsMap.entries()) {
      const prevRank = prevSeasonRanks[season]?.[corpsKey] || 15; // Default for new corps?

      // Sort shows by date (just to be absolutely safe)
      shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

      for (let i = 0; i < shows.length; i++) {
        const targetShow = shows[i];

        // --- Input Sequence (Last 15 shows) ---
        // Take shows [0..i-1] -> slice(0, i)
        // We want strict past context only.
        const pastShows = shows.slice(0, i);

        const x_sequence: number[][] = [];
        const SEQ_LEN = 15;

        for (let j = 0; j < SEQ_LEN; j++) {
          // We want indices such that the last element (j=14) is the most recent show (pastShows[last])
          // j=14 -> index = len-1
          // j=0 -> index = len-15

          const showIdx = pastShows.length - (SEQ_LEN - j);
          if (showIdx < 0) {
            // Pad
            x_sequence.push(extractFeatures(null, null, prevRank, season));
          } else {
            const show = pastShows[showIdx];
            const prevShow = showIdx > 0 ? pastShows[showIdx - 1] : null;
            x_sequence.push(extractFeatures(show, prevShow, prevRank, season));
          }
        }

        // --- Target ---
        // Compute residuals for THIS show using Baseline(rank_entering_this_show)
        // Rank entering this show = rank of last show in history?
        // Or prevRank if no history.
        const rankAsOf = pastShows.length > 0 ? pastShows[pastShows.length - 1].rank : prevRank;

        const y_residuals: Record<string, number> = {};
        const y_recap: Record<string, number> = {};

        for (const cap of CAPTIONS) {
          const actual = targetShow.captions[cap]?.score;
          if (actual !== undefined) {
            y_recap[cap] = actual;
            const baseline = getBaseline(rankAsOf, targetShow.percent_through, cap);
            y_residuals[cap] = Number((actual - baseline).toFixed(4));
          } else {
            y_residuals[cap] = 0.0;
            y_recap[cap] = 0.0;
          }
        }

        // Split logic
        let split = 'train';
        if (season === "2024") split = 'test';
        else if (season === "2023" || season === "2022") split = 'val';

        allInserts.push({
          season,
          competition_slug: targetShow.slug,
          competition_date: targetShow.date,
          division_name: division,
          corps_key: corpsKey,
          corps_id: 0,
          x_sequence_json: JSON.stringify(x_sequence),
          y_residuals_json: JSON.stringify(y_residuals),
          y_recap_json: JSON.stringify(y_recap),
          split
        });
      }
    }

    // Batch Insert
    console.log(`Inserting ${allInserts.length} rows for ${season}...`);
    const CHUNK_SIZE = 100;
    for (let i = 0; i < allInserts.length; i += CHUNK_SIZE) {
      const chunk = allInserts.slice(i, i + CHUNK_SIZE);
      yield* (insertBatch(sql, chunk));
    }
  }
});

function extractFeatures(show: any, prevShow: any, prevSeasonRank: number, season: string): number[] {
  if (!show) {
    return new Array(40).fill(0.0);
  }

  const feats: number[] = [];

  // 1. Temporal
  feats.push(show.percent_through / 100.0);

  let days = 7;
  if (prevShow) {
    const d1 = new Date(prevShow.date).getTime();
    const d2 = new Date(show.date).getTime();
    days = (d2 - d1) / (1000 * 3600 * 24);
  }
  feats.push(Math.min(days, 14) / 14.0);
  feats.push(0.5); // Placeholder showOfSeason

  // 2. Global Performance
  feats.push(normalizeScore(show.total_score));
  feats.push(normalizeRank(show.rank));
  feats.push(0.0); // Gap placeholder
  feats.push(normalizeRank(prevSeasonRank));

  // 3. Captions
  const baselineRank = show.rank;
  for (const cap of CAPTIONS) {
    const c = show.captions[cap];
    if (c) {
      const val = c.score;
      const base = getBaseline(baselineRank, show.percent_through, cap);
      feats.push(val - base); // Residual
      feats.push(normalizeRank(c.rank)); // Rank
      feats.push(normalizeScore(val)); // Raw
    } else {
      feats.push(0); feats.push(0); feats.push(0);
    }
  }

  // 4. Flags
  const isFinals = show.slug.includes('finals') ? 1.0 : 0.0;
  const isRegional = show.slug.includes('regional') ? 1.0 : 0.0;
  feats.push(isFinals);
  feats.push(isRegional);

  while (feats.length < 40) feats.push(0.0);
  return feats;
}

const insertBatch = (sql: SqlClient.SqlClient, rows: any[]) =>
  Effect.forEach(rows, row =>
    sql`
        INSERT OR REPLACE INTO ml_sequence_rows_v4 (
            season, competition_slug, competition_date, division_name, 
            corps_key, corps_id, x_sequence_json, y_residuals_json, y_recap_json, split
        ) VALUES (
            ${row.season}, ${row.competition_slug}, ${row.competition_date}, ${row.division_name},
            ${row.corps_key}, ${row.corps_id}, ${row.x_sequence_json}, ${row.y_residuals_json}, 
            ${row.y_recap_json}, ${row.split}
        )
        `.pipe(Effect.asVoid),
    { concurrency: 50, discard: true });

import { LibsqlClient } from "@effect/sql-libsql";
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(buildSequences.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V4 sequences."))
  .catch(console.error);
