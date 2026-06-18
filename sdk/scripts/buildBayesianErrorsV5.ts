import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

type PredictionFile = {
  entries: Array<{
    corps_key: string;
    predicted: Partial<Record<Caption, number>>; // predicted residual (p50)
  }>;
};

type OutputFile = {
  entries: Array<{
    corps_key: string;
    season: string;
    errors: Partial<Record<Caption, number>>;
  }>;
};

const CAPTION_MAP: Record<string, Caption> = {
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REFERENCE_CURVES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../src/training/referenceCurvesV4.json"), "utf-8")
);

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    competition: get("--competition")!,
    season: get("--season")!,
    predictions: get("--predictions")!,
    out: get("--out", "./bayesian-errors.json")!,
    division: get("--division", "World Class")!,
    db: get("--db", "./dci-relational.db")!,
  };
}

function getBaseline(rank: number, pct: number, caption: Caption): number {
  if (rank < 1) rank = 12;
  const bucket = Math.round(pct / 5) * 5;
  const key = `${rank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }

  return curves[`${rank}-50`]?.[caption] || 15.0;
}

async function main() {
  const args = parseArgs();
  if (!args.competition || !args.season || !args.predictions) {
    throw new Error("--competition, --season, and --predictions are required");
  }

  const predictionPayload = JSON.parse(fs.readFileSync(args.predictions, "utf-8")) as PredictionFile;
  const predictionMap = new Map<string, Partial<Record<Caption, number>>>(
    predictionPayload.entries.map((entry) => [entry.corps_key, entry.predicted])
  );

  const client = createClient({ url: `file:${args.db}` });

  const competitionRows = await client.execute({
    sql: `
      SELECT slug, date, percent_through
      FROM competitions
      WHERE slug = ? AND season = ?
    `,
    args: [args.competition, args.season],
  });

  if (!competitionRows.rows.length) {
    client.close();
    throw new Error(`Competition ${args.competition} not found for season ${args.season}`);
  }

  const competition = competitionRows.rows[0] as unknown as { date: string; percent_through: number };

  const captionRows = await client.execute({
    sql: `
      SELECT cs.corps_key as corps_key, cs.rank as corps_rank, cs.total_score as total_score,
             caps.caption_name as caption_name, caps.score as caption_score
      FROM corps_scores cs
      JOIN caption_scores caps
        ON caps.competition_slug = cs.competition_slug AND caps.corps_key = cs.corps_key
      WHERE cs.competition_slug = ? AND cs.division_name = ?
    `,
    args: [args.competition, args.division],
  });

  const previousSeason = args.season === "2022" ? "2019" : `${Number(args.season) - 1}`;
  const prevSeasonRows = await client.execute({
    sql: `
      SELECT cs.corps_key as corps_key, MAX(cs.total_score) as best_total
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
      WHERE comp.season = ? AND cs.division_name = ?
      GROUP BY cs.corps_key
    `,
    args: [previousSeason, args.division],
  });

  const prevRanks = new Map<string, number>();
  const prevSorted = [...(prevSeasonRows.rows as unknown as Array<{ corps_key: string; best_total: number }>)]
    .sort((a, b) => b.best_total - a.best_total);
  prevSorted.forEach((row, idx) => prevRanks.set(row.corps_key, idx + 1));

  const outputEntries: OutputFile["entries"] = [];
  const corpsMap = new Map<string, {
    corps_key: string;
    corps_rank: number;
    captions: Record<Caption, number>;
  }>();

  for (const row of captionRows.rows as unknown as Array<{ corps_key: string; corps_rank: number; caption_name: string; caption_score: number }>) {
    const caption = CAPTION_MAP[row.caption_name];
    if (!caption) continue;

    const entry = corpsMap.get(row.corps_key) ?? {
      corps_key: row.corps_key,
      corps_rank: row.corps_rank,
      captions: {} as Record<Caption, number>,
    };
    entry.captions[caption] = row.caption_score;
    corpsMap.set(row.corps_key, entry);
  }

  for (const [corpsKey, actual] of corpsMap.entries()) {
    const predicted = predictionMap.get(corpsKey);
    if (!predicted) continue;

    const priorRows = await client.execute({
      sql: `
        SELECT cs.rank as rank
        FROM corps_scores cs
        JOIN competitions comp ON comp.slug = cs.competition_slug
        WHERE comp.season = ? AND cs.corps_key = ? AND comp.date < ?
        ORDER BY comp.date DESC
        LIMIT 1
      `,
      args: [args.season, corpsKey, competition.date],
    });

    const rankEntering = (priorRows.rows[0] as unknown as { rank: number } | undefined)?.rank ?? prevRanks.get(corpsKey) ?? 15;

    const errors: Partial<Record<Caption, number>> = {};
    for (const caption of CAPTIONS) {
      const actualScore = actual.captions[caption];
      const predictedResidual = predicted[caption];
      if (actualScore === undefined || predictedResidual === undefined) continue;

      const baseline = getBaseline(rankEntering, competition.percent_through, caption);
      const actualResidual = actualScore - baseline;
      errors[caption] = Number((actualResidual - predictedResidual).toFixed(4));
    }

    outputEntries.push({
      corps_key: corpsKey,
      season: args.season,
      errors,
    });
  }

  client.close();

  const output: OutputFile = { entries: outputEntries };
  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputEntries.length} error entries to ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
