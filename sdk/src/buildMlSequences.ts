// src/buildMlSequences.ts
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "./mlQueries.js";

// ----- Types -----

export interface SequenceFeatureSpec {
  seqLen: number;
  features: string[];
}

const V3_FEATURE_SPEC: SequenceFeatureSpec = {
  seqLen: 15,
  features: [
    "percentageThroughSeason",
    "daysSinceLastShow",
    "isFinals",
    "isRegional",
    "avgFieldRank",
    "totalScore",
    "GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"
  ]
};

const CAPTION_MAP: Record<string, string> = {
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

export const ensureSequenceTables = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v3 (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER NOT NULL,
      x_sequence_json TEXT NOT NULL, -- [SeqLen, Features]
      y_recap_json TEXT NOT NULL, -- The target recap to predict
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `);
});

// ----- Helper Functions -----

function getCompetitionFlags(eventName: string) {
  const lowName = (eventName || "").toLowerCase();
  const isFinals = (lowName.includes("finals") || lowName.includes("championship")) ? 1 : 0;
  const isRegional = lowName.includes("regional") ? 1 : 0;
  return { isFinals, isRegional };
}

// ----- Main Build Logic -----

const buildSequences = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureSequenceTables);

  const seasons = ["2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024"];
  const division = "World Class";

  const comps = (yield* (MlQueries.queryCompetitionsWithRecaps(seasons, division))) as any[];
  console.log(`Processing ${comps.length} competitions for v3 sequences...`);

  let totalRows = 0;

  for (const comp of comps) {
    const corpsResults = (yield* (MlQueries.queryCorpsResults(comp.slug, comp.division_name))) as any[];
    if (corpsResults.length === 0) continue;

    // Current Competition Context
    const { isFinals, isRegional } = getCompetitionFlags(comp.event_name);

    // Current Lineup Strength
    const bestSoFar = (yield* (MlQueries.queryBestSoFar(comp.season, comp.division_name, comp.competition_date))) as any[];
    let fieldRankSum = 0;
    let fieldCount = 0;
    for (const cr of corpsResults) {
      const rankings = MlQueries.computeRankingsAsOf(cr.corps_key, [...bestSoFar]);
      if (rankings.hasOverallRank) {
        fieldRankSum += rankings.overallRankAsOf!;
        fieldCount++;
      }
    }
    const avgFieldRank = fieldCount > 0 ? fieldRankSum / fieldCount : 12;

    for (const corps of corpsResults) {
      if (!corps.corps_key) {
        console.warn(`Corps key missing for a result in ${comp.slug}`);
        continue;
      }

      // Get target recap
      const yRecap = (yield* (MlQueries.queryDetailedCaptions(comp.slug, corps.corps_key))) as any[];
      if (totalRows === 0) console.log(`Got yRecap for ${corps.corps_key}`);
      const targetMap: Record<string, number> = {};
      for (const r of yRecap) {
        const std = CAPTION_MAP[r.caption_name];
        if (std) targetMap[std] = r.score;
      }
      if (Object.keys(targetMap).length === 0) continue;

      // Get history (up to predict date)
      const history = (yield* (MlQueries.queryPriorShows(comp.season, comp.division_name, corps.corps_key, comp.competition_date, 20))) as any[];
      if (totalRows === 0) console.log(`Got history: ${history.length} shows`);

      const sequence: number[][] = [];
      for (let i = 0; i < V3_FEATURE_SPEC.seqLen; i++) {
        const show = history[i];
        if (!show) {
          sequence.push(new Array(V3_FEATURE_SPEC.features.length).fill(0));
          continue;
        }

        if (totalRows === 0) console.log(`Step ${i}: ${show.competition_slug}`);

        // Fetch detailed recap for this historical show
        const histRecap = (yield* (MlQueries.queryDetailedCaptions(show.competition_slug, corps.corps_key))) as any[];
        const histMap: Record<string, number> = {};
        for (const hr of histRecap) {
          const std = CAPTION_MAP[hr.caption_name];
          if (std) histMap[std] = hr.score;
        }

        // Days since show
        const nextShow = history[i + 1];
        const daysSinceLast = nextShow ?
          (new Date(show.competition_date).getTime() - new Date(nextShow.competition_date).getTime()) / (1000 * 3600 * 24) : -1;

        const feat: number[] = [
          show.percent_through ?? 0,
          daysSinceLast,
          0,
          0,
          0,
          show.total_score,
          histMap["GE1"] ?? 0, histMap["GE2"] ?? 0, histMap["VP"] ?? 0, histMap["VA"] ?? 0,
          histMap["CG"] ?? 0, histMap["MB"] ?? 0, histMap["MA"] ?? 0, histMap["MP"] ?? 0
        ];
        sequence.push(feat);
      }

      sequence.reverse();

      let split: "train" | "val" | "test" = "train";
      if (comp.season === "2024") {
        if (comp.competition_date >= "2024-08-01") split = "test";
        else if (comp.competition_date >= "2024-07-20") split = "val";
      }

      const corpsIdRow = (yield* (sql`SELECT corps_id FROM ml_corps_vocab WHERE corps_key = ${corps.corps_key ?? ""} LIMIT 1`)) as any;
      const corpsId = corpsIdRow[0]?.corps_id ?? 0;

      if (totalRows < 5) {
        console.log(`Inserting: ${comp.season} ${comp.slug} ${corps.corps_key} id:${corpsId} split:${split}`);
      }

      yield* (sql`
        INSERT INTO ml_sequence_rows_v3 (
          season, competition_slug, competition_date, division_name, corps_key, corps_id,
          x_sequence_json, y_recap_json, split
        ) VALUES (
          ${comp.season ?? ""}, ${comp.slug ?? ""}, ${comp.competition_date ?? ""}, ${comp.division_name ?? ""}, ${corps.corps_key ?? ""}, ${corpsId},
          ${JSON.stringify(sequence)}, ${JSON.stringify(targetMap)}, ${split}
        )
        ON CONFLICT(season, competition_slug, division_name, corps_key)
        DO UPDATE SET
          x_sequence_json=excluded.x_sequence_json,
          y_recap_json=excluded.y_recap_json,
          split=excluded.split
      `);
      totalRows++;
    }
  }
  return { totalRows, competitions: comps.length };
});

// ----- Runnable -----

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("buildMlSequences.ts");

if (isMain) {
  const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
  Effect.runPromise(buildSequences.pipe(Effect.provide(SqlLayer)))
    .then(r => console.log(`Built ${r.totalRows} sequences from ${r.competitions} comps.`))
    .catch(console.error);
}
