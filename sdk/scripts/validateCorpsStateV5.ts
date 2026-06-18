import { createClient } from "@libsql/client";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

type StateRow = {
  corps_key: string;
  season: string;
  shows_completed: number;
  last_show_date: string | null;
  residual_ema_json: string;
  residual_mean_json: string;
  residual_var_json: string;
  best_residual_json: string;
  worst_residual_json: string;
  rank_history_json: string;
  total_score_history_json: string;
};

type SeasonSummary = {
  count: number;
  minShows: number;
  maxShows: number;
  totalShows: number;
  mismatchedHistory: number;
  invalidStats: number;
};

function emptySeasonSummary(): SeasonSummary {
  return {
    count: 0,
    minShows: Number.POSITIVE_INFINITY,
    maxShows: 0,
    totalShows: 0,
    mismatchedHistory: 0,
    invalidStats: 0,
  };
}

function isFiniteRecord(record: Record<string, number>): boolean {
  return Object.values(record).every((value) => Number.isFinite(value));
}

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });

  const rowsResult = await client.execute({
    sql: `
      SELECT
        corps_key,
        season,
        shows_completed,
        last_show_date,
        residual_ema_json,
        residual_mean_json,
        residual_var_json,
        best_residual_json,
        worst_residual_json,
        rank_history_json,
        total_score_history_json
      FROM corps_season_state_v5
    `,
  });

  const rows = rowsResult.rows as unknown as StateRow[];
  client.close();

  if (!rows.length) {
    throw new Error("No rows found in corps_season_state_v5.");
  }

  const summaries = new Map<string, SeasonSummary>();

  for (const row of rows) {
    const summary = summaries.get(row.season) ?? emptySeasonSummary();
    summary.count += 1;
    summary.totalShows += row.shows_completed;
    summary.minShows = Math.min(summary.minShows, row.shows_completed);
    summary.maxShows = Math.max(summary.maxShows, row.shows_completed);

    const rankHistory = JSON.parse(row.rank_history_json) as number[];
    const scoreHistory = JSON.parse(row.total_score_history_json) as number[];
    if (rankHistory.length !== row.shows_completed || scoreHistory.length !== row.shows_completed) {
      summary.mismatchedHistory += 1;
    }

    const ema = JSON.parse(row.residual_ema_json) as Record<Caption, number>;
    const mean = JSON.parse(row.residual_mean_json) as Record<Caption, number>;
    const vari = JSON.parse(row.residual_var_json) as Record<Caption, number>;
    const best = JSON.parse(row.best_residual_json) as Record<Caption, number>;
    const worst = JSON.parse(row.worst_residual_json) as Record<Caption, number>;

    if (!isFiniteRecord(ema) || !isFiniteRecord(mean) || !isFiniteRecord(vari) || !isFiniteRecord(best) || !isFiniteRecord(worst)) {
      summary.invalidStats += 1;
    }

    summaries.set(row.season, summary);
  }

  const seasons = Array.from(summaries.keys()).sort();

  console.log("Corps season state validation (v5)");
  console.log("--------------------------------");

  for (const season of seasons) {
    const summary = summaries.get(season)!;
    const avgShows = summary.totalShows / summary.count;
    console.log(
      `${season}: corps=${summary.count} avgShows=${avgShows.toFixed(2)} min=${summary.minShows} max=${summary.maxShows}` +
        ` mismatched=${summary.mismatchedHistory} invalidStats=${summary.invalidStats}`
    );
  }

  const totalMismatched = seasons.reduce((acc, season) => acc + summaries.get(season)!.mismatchedHistory, 0);
  const totalInvalid = seasons.reduce((acc, season) => acc + summaries.get(season)!.invalidStats, 0);
  console.log("--------------------------------");
  console.log(`Total rows: ${rows.length}`);
  console.log(`Rows with history mismatch: ${totalMismatched}`);
  console.log(`Rows with invalid stats: ${totalInvalid}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
