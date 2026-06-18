import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as MlQueries from "../src/mlQueries.js";
import {
  CAPTIONS,
  ensureCorpsSeasonStateTable,
  initializeCorpsSeasonState,
  saveCorpsSeasonState,
  updateCorpsSeasonState,
  type ShowResult,
} from "../src/featureStoreV5.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REFERENCE_CURVES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../src/training/referenceCurvesV4.json"), "utf-8")
);

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

const SEASONS = [
  "2013",
  "2014",
  "2015",
  "2016",
  "2017",
  "2018",
  "2019",
  "2022",
  "2023",
  "2024",
];
const DIVISION = "World Class";

function getBaseline(rank: number, pct: number, caption: string): number {
  if (rank < 1) rank = 12;
  const bucket = Math.round(pct / 5) * 5;
  const key = `${rank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }

  return curves[`${rank}-50`]?.[caption] || 15.0;
}

const ensureCorpsCompetitionResultsView = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE VIEW IF NOT EXISTS corps_competition_results AS
      SELECT
        comp.season AS season,
        comp.slug AS competition_slug,
        comp.event_name AS event_name,
        comp.date AS competition_date,
        comp.location AS location,
        comp.day_of_season AS day_of_season,
        comp.days_till_finals AS days_till_finals,
        comp.percent_through AS percent_through,
        cs.corps_key AS corps_key,
        cs.corps_name AS corps_name,
        cs.division_name AS division_name,
        cs.rank AS corps_rank,
        cs.total_score AS total_score,
        cs.subtotal_score AS subtotal_score,
        cs.subtotal_rank AS subtotal_rank,
        cs.group_type_id AS group_type_id,
        cs.competition_type_id AS competition_type_id
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
  `.pipe(Effect.asVoid);

export const backfillCorpsSeasonState = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureCorpsSeasonStateTable);
  yield* (ensureCorpsCompetitionResultsView(sql));

  const prevSeasonRanks: Record<string, Record<string, number>> = {};
  for (const season of SEASONS) {
    let prevYear = parseInt(season, 10) - 1;
    if (season === "2022") prevYear = 2019;

    const raw = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevYear.toString(), DIVISION));
    const sortedRaw = [...raw].sort((a, b) => b.best_total - a.best_total);
    prevSeasonRanks[season] = {};
    sortedRaw.forEach((row, idx) => {
      prevSeasonRanks[season]![row.corps_key] = idx + 1;
    });
  }

  for (const season of SEASONS) {
    console.log(`Backfilling corps state for ${season}...`);
    const rows = yield* (MlQueries.querySeasonCaptions(season, DIVISION));

    const corpsMap = new Map<string, any[]>();

    for (const row of rows) {
      if (!corpsMap.has(row.corps_key)) corpsMap.set(row.corps_key, []);
      const shows = corpsMap.get(row.corps_key)!;

      let lastShow = shows[shows.length - 1];
      if (!lastShow || lastShow.slug !== row.slug) {
        lastShow = {
          slug: row.slug,
          date: row.date,
          percent_through: row.percent_through,
          rank: row.rank,
          total_score: row.total_score,
          captions: {},
        };
        shows.push(lastShow);
      }

      const capKey = CAPTION_MAP[row.caption_name];
      if (capKey) {
        lastShow.captions[capKey] = { score: row.score, rank: row.caption_rank };
      }
    }

    for (const [corpsKey, shows] of corpsMap.entries()) {
      const prevRank = prevSeasonRanks[season]?.[corpsKey] ?? 15;
      shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let state = initializeCorpsSeasonState(corpsKey, season);

      for (let i = 0; i < shows.length; i++) {
        const show = shows[i];
        const rankEntering = i > 0 ? shows[i - 1].rank : prevRank;

        const residuals = {} as Record<(typeof CAPTIONS)[number], number>;
        for (const caption of CAPTIONS) {
          const actual = show.captions[caption]?.score;
          if (actual === undefined) {
            residuals[caption] = 0;
            continue;
          }
          const baseline = getBaseline(rankEntering, show.percent_through, caption);
          residuals[caption] = Number((actual - baseline).toFixed(4));
        }

        const showResult: ShowResult = {
          corps_key: corpsKey,
          season,
          date: show.date,
          rank: show.rank,
          total_score: show.total_score,
          residuals,
        };

        state = updateCorpsSeasonState(state, showResult);
        yield* (saveCorpsSeasonState(state));
      }
    }
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(backfillCorpsSeasonState.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Backfill complete."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
