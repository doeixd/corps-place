import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findLatestV9SubcaptionModelDir } from '../src/training/v9ModelPaths.js';
import {
  loadV9SubcaptionModel,
  CAPTIONS,
  type Caption,
} from '../src/training/v9SubcaptionInference.js';

const DB_PATH = './dci-relational.db';
const JUDGE_INDEX_PATH = './src/training/judgeIndexMap.json';
const FEAT_DIM = 101;
const RAW_STATIC_DIM = 212;
const SEQ_LEN = 15;
const PADDING_INDEX = 3;
const CAPTION_COUNT = CAPTIONS.length;

type Args = {
  db: string;
  modelDir?: string;
  split: string;
  division: string;
  maxContexts: number;
  maxJudgesPerCaption: number;
  minAppearances: number;
  outputJson: string;
  outputCsv: string;
};

type MlRow = {
  season: string;
  competition_slug: string;
  competition_date: string;
  division_name: string;
  corps_key: string;
  corps_id: number;
  x_sequence_json: string;
  x_static_json: string;
  judge_indices_json: string;
  y_recap_json: string;
  y_total: number;
  agnostic_show_id: number;
  split: string;
};

type ContextRow = {
  season: string;
  competitionSlug: string;
  date: string;
  division: string;
  corpsKey: string;
  corpsId: number;
  sequence: number[][];
  staticFeatures: number[];
  trendSlopes: number[];
  actualJudges: number[];
  recap: number[];
  total: number;
  agnosticShowId: number;
  split: string;
};

const usage = () => `Usage:
  npx tsx scripts/analyzeV9JudgeImpacts.ts [options]

Options:
  --db <path>                     SQLite DB. Default: ${DB_PATH}
  --model-dir <path|latest>        V9 model dir. Default: latest
  --split <test|val|train|all>     Context rows to sample. Default: test
  --division <all|World Class|Open Class>  Default: all
  --max-contexts <n>               Context rows per experiment. Default: 64
  --max-judges-per-caption <n>     Most frequent judges per caption. Default: 25
  --min-appearances <n>            Min caption assignments for a judge. Default: 8
  --out-json <path>                Default: results/judge-impact-v9.json
  --out-csv <path>                 Default: results/judge-impact-v9.csv

Method:
  For each sampled context, compare an all-unknown judge panel to a counterfactual
  panel with one caption slot set to a candidate judge. This estimates the model's
  learned judge embedding effect, not a causal real-world scoring effect.`;

const getArg = (argv: string[], name: string, fallback?: string) => {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : fallback;
};

const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  return {
    db: getArg(argv, '--db', DB_PATH)!,
    modelDir: getArg(argv, '--model-dir', 'latest'),
    split: getArg(argv, '--split', 'test')!,
    division: getArg(argv, '--division', 'all')!,
    maxContexts: Number(getArg(argv, '--max-contexts', '64')),
    maxJudgesPerCaption: Number(getArg(argv, '--max-judges-per-caption', '25')),
    minAppearances: Number(getArg(argv, '--min-appearances', '8')),
    outputJson: getArg(argv, '--out-json', 'results/judge-impact-v9.json')!,
    outputCsv: getArg(argv, '--out-csv', 'results/judge-impact-v9.csv')!,
  };
};

const recapVector = (json: string) => {
  const recap = JSON.parse(json) as Record<Caption, number>;
  return CAPTIONS.map((caption) => Number(recap[caption] ?? 0));
};

const totalFromRecap = (recap: number[]) =>
  (recap[0] ?? 0) +
  (recap[1] ?? 0) +
  ((recap[2] ?? 0) + (recap[3] ?? 0) + (recap[4] ?? 0)) / 2 +
  ((recap[5] ?? 0) + (recap[6] ?? 0) + (recap[7] ?? 0)) / 2;

const normalizeSequence = (json: string) => {
  const raw = JSON.parse(json) as number[][];
  const sequence = raw.map((step) =>
    step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step.slice(0, FEAT_DIM)
  );
  while (sequence.length < SEQ_LEN) sequence.unshift(new Array(FEAT_DIM).fill(0));
  return sequence.slice(-SEQ_LEN);
};

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sd = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
  );
};

const csvEscape = (value: unknown) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function addTrendSlopes(rows: ContextRow[]) {
  const byCorps = new Map<string, ContextRow[]>();
  for (const row of rows) {
    const key = `${row.division}:${row.corpsKey}`;
    const group = byCorps.get(key) ?? [];
    group.push(row);
    byCorps.set(key, group);
  }

  for (const group of byCorps.values()) {
    group.sort(
      (a, b) => a.date.localeCompare(b.date) || a.competitionSlug.localeCompare(b.competitionSlug)
    );
    const history: number[][] = Array.from({ length: CAPTION_COUNT }, () => []);
    for (const row of group) {
      row.trendSlopes = CAPTIONS.map((_, idx) => {
        const recent = history[idx]!.slice(-3);
        return recent.length >= 2 ? (recent.at(-1)! - recent[0]!) / (recent.length - 1) / 0.1 : 0;
      });
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        history[idx]!.push(row.recap[idx] ?? 0);
        if (history[idx]!.length > 3) history[idx]!.shift();
      }
    }
  }
}

async function loadContexts(dbUrl: string, args: Args) {
  const db = createClient({ url: `file:${dbUrl}` });
  try {
    const result = await db.execute(`
      SELECT season, competition_slug, competition_date, division_name, corps_key, corps_id,
             x_sequence_json, x_static_json, judge_indices_json, y_recap_json, y_total,
             agnostic_show_id, split
      FROM ml_sequence_rows_v9_subcaption
      ORDER BY competition_date, competition_slug, corps_key
    `);
    const rows = (result.rows as unknown as MlRow[])
      .map((row) => {
        const recap = recapVector(row.y_recap_json);
        const stat = JSON.parse(row.x_static_json) as number[];
        return {
          season: row.season,
          competitionSlug: row.competition_slug,
          date: row.competition_date,
          division: row.division_name,
          corpsKey: row.corps_key,
          corpsId: Number(row.corps_id ?? 0),
          sequence: normalizeSequence(row.x_sequence_json),
          staticFeatures: stat.slice(0, RAW_STATIC_DIM),
          trendSlopes: new Array(CAPTION_COUNT).fill(0),
          actualJudges: JSON.parse(row.judge_indices_json) as number[],
          recap,
          total: Number(row.y_total || totalFromRecap(recap)),
          agnosticShowId: Number(row.agnostic_show_id ?? 0),
          split: row.split,
        } satisfies ContextRow;
      })
      .filter(
        (row) =>
          row.staticFeatures.length === RAW_STATIC_DIM &&
          (args.division === 'all' || row.division === args.division)
      );
    addTrendSlopes(rows);
    return rows
      .filter((row) => args.split === 'all' || row.split === args.split)
      .slice(-args.maxContexts);
  } finally {
    db.close();
  }
}

async function loadJudgeCandidates(
  dbUrl: string,
  args: Args,
  judgeIndexMap: Record<string, number>
) {
  const db = createClient({ url: `file:${dbUrl}` });
  try {
    const rows = await db.execute({
      sql: `
        SELECT ja.normalized_caption_name AS caption,
               ja.judge_id,
               COALESCE(j.display_name, ja.judge_id) AS display_name,
               COUNT(*) AS appearances
        FROM judge_assignments ja
        LEFT JOIN judges j ON j.judge_id = ja.judge_id
        WHERE ja.normalized_caption_name IN (${CAPTIONS.map(() => '?').join(',')})
          AND ja.judge_id IS NOT NULL
          AND ja.judge_id NOT LIKE '%unknown%'
          AND ja.judge_id NOT LIKE '%missing%'
        GROUP BY ja.normalized_caption_name, ja.judge_id
        HAVING COUNT(*) >= ?
        ORDER BY ja.normalized_caption_name, COUNT(*) DESC, ja.judge_id
      `,
      args: [...CAPTIONS, args.minAppearances],
    });
    const byCaption = new Map<
      Caption,
      Array<{
        caption: Caption;
        judgeId: string;
        judgeIndex: number;
        displayName: string;
        appearances: number;
      }>
    >();
    for (const row of rows.rows as any[]) {
      const caption = row.caption as Caption;
      const judgeIndex = judgeIndexMap[row.judge_id] ?? 0;
      if (!CAPTIONS.includes(caption) || judgeIndex <= 0) continue;
      const list = byCaption.get(caption) ?? [];
      if (list.length < args.maxJudgesPerCaption) {
        list.push({
          caption,
          judgeId: String(row.judge_id),
          judgeIndex,
          displayName: String(row.display_name ?? row.judge_id),
          appearances: Number(row.appearances ?? 0),
        });
      }
      byCaption.set(caption, list);
    }
    return byCaption;
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelDir =
    args.modelDir === 'latest' || !args.modelDir ? findLatestV9SubcaptionModelDir() : args.modelDir;
  if (!modelDir) throw new Error('No V9 model found. Pass --model-dir <path>.');
  const judgeIndexMap = JSON.parse(fs.readFileSync(JUDGE_INDEX_PATH, 'utf-8')) as Record<
    string,
    number
  >;
  const contexts = await loadContexts(args.db, args);
  if (!contexts.length) throw new Error('No context rows selected.');
  const candidates = await loadJudgeCandidates(args.db, args, judgeIndexMap);
  const model = await loadV9SubcaptionModel(modelDir);

  const results: any[] = [];
  try {
    for (const caption of CAPTIONS) {
      const slot = CAPTIONS.indexOf(caption);
      const captionCandidates = candidates.get(caption) ?? [];
      for (const candidate of captionCandidates) {
        const ownImpacts: number[] = [];
        const totalImpacts: number[] = [];
        const categoryImpacts: number[] = [];
        for (const context of contexts) {
          const staticFeatures = [...context.staticFeatures, ...context.trendSlopes];
          const base = model.predictOne({
            sequence: context.sequence,
            staticFeatures,
            judgeIndices: new Array(CAPTION_COUNT).fill(0),
            corpsId: context.corpsId,
            agnosticShowId: context.agnosticShowId,
            judgeBiasScale: 1,
            corpsScale: 1,
          });
          const judgeIndices = new Array(CAPTION_COUNT).fill(0);
          judgeIndices[slot] = candidate.judgeIndex;
          const counterfactual = model.predictOne({
            sequence: context.sequence,
            staticFeatures,
            judgeIndices,
            corpsId: context.corpsId,
            agnosticShowId: context.agnosticShowId,
            judgeBiasScale: 1,
            corpsScale: 1,
          });
          ownImpacts.push(counterfactual.captions[caption].p50 - base.captions[caption].p50);
          totalImpacts.push(counterfactual.total - base.total);
          const category =
            caption === 'GE1' || caption === 'GE2'
              ? 'ge'
              : caption === 'VP' || caption === 'VA' || caption === 'CG'
                ? 'visual'
                : 'music';
          categoryImpacts.push(counterfactual.categories[category] - base.categories[category]);
        }
        results.push({
          caption,
          judge_id: candidate.judgeId,
          judge_index: candidate.judgeIndex,
          judge_name: candidate.displayName,
          appearances: candidate.appearances,
          contexts: contexts.length,
          own_caption_mean: mean(ownImpacts),
          own_caption_abs_mean: mean(ownImpacts.map(Math.abs)),
          own_caption_sd: sd(ownImpacts),
          total_mean: mean(totalImpacts),
          total_abs_mean: mean(totalImpacts.map(Math.abs)),
          total_sd: sd(totalImpacts),
          category_mean: mean(categoryImpacts),
          category_abs_mean: mean(categoryImpacts.map(Math.abs)),
          positive_pct:
            ownImpacts.filter((value) => value > 0).length / Math.max(1, ownImpacts.length),
        });
      }
    }
  } finally {
    model.dispose();
  }

  const output = {
    generated_at: new Date().toISOString(),
    model_dir: model.modelDir,
    db: args.db,
    method: 'counterfactual_one_caption_judge_vs_unknown_panel',
    caveats: [
      'This measures learned model sensitivity to judge embeddings, not causal real-world judge behavior.',
      'Effects depend on selected context rows, model checkpoint, and whether the model learned stable judge embeddings.',
      'Candidate panels use one named judge in one caption slot and unknown judges elsewhere.',
    ],
    args,
    rows: results.sort((a, b) => b.own_caption_abs_mean - a.own_caption_abs_mean),
  };

  fs.mkdirSync(path.dirname(args.outputJson), { recursive: true });
  fs.writeFileSync(args.outputJson, JSON.stringify(output, null, 2));
  const columns = [
    'caption',
    'judge_id',
    'judge_name',
    'appearances',
    'contexts',
    'own_caption_mean',
    'own_caption_abs_mean',
    'own_caption_sd',
    'category_mean',
    'category_abs_mean',
    'total_mean',
    'total_abs_mean',
    'total_sd',
    'positive_pct',
  ];
  fs.writeFileSync(
    args.outputCsv,
    [
      columns.join(','),
      ...output.rows.map((row) => columns.map((col) => csvEscape(row[col])).join(',')),
    ].join('\n')
  );

  console.log(
    `Analyzed ${results.length} judge-caption candidates across ${contexts.length} contexts.`
  );
  console.log(`Model: ${modelDir}`);
  console.log(`Wrote ${args.outputJson}`);
  console.log(`Wrote ${args.outputCsv}`);
  console.log('\nLargest own-caption absolute impacts:');
  console.table(
    output.rows.slice(0, 20).map((row) => ({
      caption: row.caption,
      judge: row.judge_name,
      own_mean: row.own_caption_mean.toFixed(4),
      own_abs: row.own_caption_abs_mean.toFixed(4),
      total_mean: row.total_mean.toFixed(4),
      pos_pct: row.positive_pct.toFixed(2),
    }))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
