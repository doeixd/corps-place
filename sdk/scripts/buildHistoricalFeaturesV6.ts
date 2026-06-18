import { createClient } from "@libsql/client";

const DIVISION = "World Class";
const FINALS_CUTOFF = 12;

type SeasonRank = { season: number; rank: number };

type CorpsHistory = {
  corpsKey: string;
  seasons: SeasonRank[];
};

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });

  console.log("Setting up corps_historical_features_v6 table...");
  await client.execute({
    sql: `
      CREATE TABLE IF NOT EXISTS corps_historical_features_v6 (
        corps_key TEXT PRIMARY KEY,
        years_in_world_class INTEGER NOT NULL,
        historical_mean_rank REAL NOT NULL,
        historical_std_rank REAL NOT NULL,
        historical_best_rank INTEGER NOT NULL,
        best_rank_recency INTEGER NOT NULL,
        made_finals_rate REAL NOT NULL,
        first_season INTEGER NOT NULL,
        last_season INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
  });

  console.log("Computing season rankings...");
  const rowsResult = await client.execute({
    sql: `
      SELECT comp.season as season, cs.corps_key as corps_key, MAX(cs.total_score) as best_total
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
      WHERE cs.division_name = ?
      GROUP BY comp.season, cs.corps_key
    `,
    args: [DIVISION],
  });

  const rows = rowsResult.rows as unknown as Array<{ season: string; corps_key: string; best_total: number }>;
  if (!rows.length) {
    client.close();
    throw new Error("No corps scores found for historical feature build.");
  }

  const seasons = Array.from(new Set(rows.map((row) => Number(row.season)))).sort((a, b) => a - b);
  const maxSeason = seasons[seasons.length - 1]!;

  const seasonGroups = new Map<number, Array<{ corps_key: string; best_total: number }>>();
  for (const row of rows) {
    const season = Number(row.season);
    const list = seasonGroups.get(season) ?? [];
    list.push({ corps_key: row.corps_key, best_total: row.best_total });
    seasonGroups.set(season, list);
  }

  const corpsHistory = new Map<string, CorpsHistory>();

  for (const [season, list] of seasonGroups.entries()) {
    const sorted = [...list].sort((a, b) => b.best_total - a.best_total);
    sorted.forEach((entry, index) => {
      const rank = index + 1;
      const history = corpsHistory.get(entry.corps_key) ?? { corpsKey: entry.corps_key, seasons: [] };
      history.seasons.push({ season, rank });
      corpsHistory.set(entry.corps_key, history);
    });
  }

  const insertRows: any[] = [];

  for (const history of corpsHistory.values()) {
    const ranks = history.seasons.map((entry) => entry.rank);
    const years = history.seasons.map((entry) => entry.season);

    const yearsInWorldClass = ranks.length;
    const meanRank = mean(ranks);
    const stdRank = std(ranks);
    const bestRank = Math.min(...ranks);

    // Recency: years since the last time they hit their best rank
    const bestSeason = Math.max(...history.seasons.filter((entry) => entry.rank === bestRank).map((entry) => entry.season));
    const bestRankRecency = maxSeason - bestSeason;

    const finalsCount = ranks.filter((rank) => rank <= FINALS_CUTOFF).length;
    const madeFinalsRate = finalsCount / yearsInWorldClass;
    const firstSeason = Math.min(...years);
    const lastSeason = Math.max(...years);

    insertRows.push([
      history.corpsKey,
      yearsInWorldClass,
      meanRank,
      stdRank,
      bestRank,
      bestRankRecency,
      madeFinalsRate,
      firstSeason,
      lastSeason,
    ]);
  }

  console.log("Cleaning old V6 historical features...");
  await client.execute({
    sql: `DELETE FROM corps_historical_features_v6`,
  });

  console.log(`Inserting ${insertRows.length} corps features...`);
  for (const row of insertRows) {
    await client.execute({
      sql: `
        INSERT INTO corps_historical_features_v6 (
          corps_key,
          years_in_world_class,
          historical_mean_rank,
          historical_std_rank,
          historical_best_rank,
          best_rank_recency,
          made_finals_rate,
          first_season,
          last_season
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: row,
    });
  }

  console.log(`Wrote ${insertRows.length} historical corps feature rows.`);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
