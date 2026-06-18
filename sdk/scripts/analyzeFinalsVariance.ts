import { createClient } from "@libsql/client";

const DB_PATH = "./dci-relational.db";

const CAPTION_MAP: Record<string, string> = {
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  "Visual Analysis": "VA",
  "Visual - Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
  GE1: "GE1",
  GE2: "GE2",
  VP: "VP",
  VA: "VA",
  CG: "CG",
  MB: "MB",
  MA: "MA",
  MP: "MP",
};

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

const normalizeRound = (round: string | null) => {
  if (!round) return null;
  const lower = round.toLowerCase();
  if (lower.includes("prelim")) return "prelims";
  if (lower.includes("semi")) return "semis";
  if (lower.includes("final")) return "finals";
  if (lower.includes("championship prelim")) return "prelims";
  if (lower.includes("championship semi")) return "semis";
  if (lower.includes("championship final")) return "finals";
  return null;
};

const variance = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
};

type CaptionScores = Record<string, number>;

type CorpsEntry = {
  finalsRank?: number;
  rounds: Record<string, CaptionScores>;
};

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });

  const result = await client.execute(`
    SELECT
      c.season as season,
      cs.round as round,
      cs.corps_key as corps_key,
      cs.rank as rank,
      cs.competition_slug as competition_slug,
      c.event_name as event_name,
      cap.caption_name as caption_name,
      cap.score as score
    FROM caption_scores cap
    JOIN corps_scores cs
      ON cs.competition_slug = cap.competition_slug
     AND cs.corps_key = cap.corps_key
    JOIN competitions c
      ON c.slug = cs.competition_slug
    WHERE (cs.competition_slug LIKE '%championship%' OR c.event_name LIKE '%Championship%')
      AND c.season IN ('2013', '2014', '2015', '2016', '2017', '2018', '2019', '2022', '2023', '2024', '2025')
      AND cs.division_name = 'World Class'
  `);

  const rows = result.rows as unknown as Array<{
    season: string;
    round: string | null;
    corps_key: string;
    rank: number | null;
    competition_slug: string;
    event_name: string | null;
    caption_name: string;
    score: number | null;
  }>;

  client.close();

  const seasonMap = new Map<string, Map<string, CorpsEntry>>();

  for (const row of rows) {
    const roundKey = normalizeRound(row.competition_slug) ?? normalizeRound(row.round) ?? normalizeRound(row.event_name);
    if (!roundKey) continue;
    const caption = CAPTION_MAP[row.caption_name];
    if (!caption) continue;

    if (!seasonMap.has(row.season)) {
      seasonMap.set(row.season, new Map());
    }
    const corpsMap = seasonMap.get(row.season)!;
    const entry = corpsMap.get(row.corps_key) ?? { rounds: {} };

    if (!entry.rounds[roundKey]) {
      entry.rounds[roundKey] = {};
    }
    entry.rounds[roundKey]![caption] = row.score ?? 0;

    if (roundKey === "finals") {
      entry.finalsRank = row.rank ?? entry.finalsRank;
    }

    corpsMap.set(row.corps_key, entry);
  }

  for (const [season, corpsMap] of seasonMap.entries()) {
    const corpsEntries = Array.from(corpsMap.entries())
      .map(([corpsKey, entry]) => ({ corpsKey, entry }))
      .filter(({ entry }) => {
        const finalsRank = entry.finalsRank ?? 999;
        return finalsRank <= 12 && entry.rounds.prelims && entry.rounds.semis && entry.rounds.finals;
      });

    if (!corpsEntries.length) {
      console.log(`Season ${season}: no corps with prelims/semis/finals + finals rank <= 12`);
      continue;
    }

    const captionStats: Record<string, number[]> = {};
    const rankStats: Record<number, number[]> = {};

    for (const caption of CAPTIONS) {
      captionStats[caption] = [];
    }

    for (const { entry } of corpsEntries) {
      const finalsRank = entry.finalsRank ?? 999;
      const perCaptionVariances: number[] = [];

      for (const caption of CAPTIONS) {
        const scores = [
          entry.rounds.prelims?.[caption] ?? 0,
          entry.rounds.semis?.[caption] ?? 0,
          entry.rounds.finals?.[caption] ?? 0,
        ];
        const v = variance(scores);
        captionStats[caption]!.push(v);
        perCaptionVariances.push(v);
      }

      const avgCaptionVariance = perCaptionVariances.reduce((sum, value) => sum + value, 0) / perCaptionVariances.length;
      if (!rankStats[finalsRank]) rankStats[finalsRank] = [];
      rankStats[finalsRank]!.push(avgCaptionVariance);
    }

    const captionSummary = CAPTIONS.map((caption) => {
      const values = captionStats[caption] ?? [];
      const meanVar = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      return { caption, avgVariance: Number(meanVar.toFixed(4)), samples: values.length };
    });

    const rankSummary = Object.keys(rankStats)
      .map((rankKey) => {
        const rank = Number(rankKey);
        const values = rankStats[rank] ?? [];
        const meanVar = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
        return { finalsRank: rank, avgVariance: Number(meanVar.toFixed(4)), samples: values.length };
      })
      .sort((a, b) => a.finalsRank - b.finalsRank);

    const overallVariance = captionSummary.reduce((sum, row) => sum + row.avgVariance, 0) / captionSummary.length;

    console.log(`\nSeason ${season} (corps: ${corpsEntries.length})`);
    console.table(captionSummary);
    console.log(`Overall avg variance across captions: ${overallVariance.toFixed(4)}`);
    console.table(rankSummary);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
