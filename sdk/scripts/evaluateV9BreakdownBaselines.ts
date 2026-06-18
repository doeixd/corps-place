import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  extractV9BreakdownPriorFeatures,
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
} from '../src/training/v9BreakdownData.js';

type BreakdownRow = {
  division_name: string;
  split: string;
  anchor_mode: string;
  x_static_json: string;
  v9_pred_recap_json: string;
  y_subcaption_json: string;
  y_subcaption_mask_json: string;
};

type RatioKey = `${string}|${V9BreakdownCaption}`;

type MetricAccumulator = {
  count: number;
  contentAbs: number;
  achievementAbs: number;
  shareAbs: number;
  sumAbs: number;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  return {
    dbPath: get('--db', 'dci-relational.db')!,
    output: get('--output', 'results/v9-breakdown-baseline-eval.json')!,
    sourceModelId: get('--source-model-id', 'anchor-synthetic-v9-breakdown-mvp')!,
  };
};

const emptyMetrics = (): MetricAccumulator => ({
  count: 0,
  contentAbs: 0,
  achievementAbs: 0,
  shareAbs: 0,
  sumAbs: 0,
});

const addMetric = (
  acc: MetricAccumulator,
  prediction: { content: number; achievement: number },
  target: { content: number; achievement: number },
  anchorTotal: number
) => {
  const targetTotal = target.content + target.achievement;
  if (targetTotal <= 0 || anchorTotal <= 0) return;
  acc.count += 1;
  acc.contentAbs += Math.abs(prediction.content - target.content);
  acc.achievementAbs += Math.abs(prediction.achievement - target.achievement);
  acc.shareAbs += Math.abs(prediction.content / anchorTotal - target.content / targetTotal);
  acc.sumAbs += Math.abs(prediction.content + prediction.achievement - anchorTotal);
};

const finish = (acc: MetricAccumulator) => ({
  pairs: acc.count,
  content_mae_pts: acc.count ? acc.contentAbs / acc.count : null,
  achievement_mae_pts: acc.count ? acc.achievementAbs / acc.count : null,
  subcaption_mae_pts: acc.count ? (acc.contentAbs + acc.achievementAbs) / (acc.count * 2) : null,
  content_share_mae: acc.count ? acc.shareAbs / acc.count : null,
  anchor_sum_error_pts: acc.count ? acc.sumAbs / acc.count : null,
});

const ratioKey = (division: string, caption: V9BreakdownCaption): RatioKey => `${division}|${caption}`;

const blendedPriorShare = (
  historicalShare: number,
  staticFeatures: readonly number[],
  captionIdx: number
) => {
  const priorFeatures = extractV9BreakdownPriorFeatures(staticFeatures);
  const lastShare = priorFeatures.lastShare[captionIdx];
  const emaShare = priorFeatures.emaShare[captionIdx];
  if (lastShare != null && emaShare != null) return historicalShare * 0.5 + emaShare * 0.3 + lastShare * 0.2;
  if (emaShare != null) return historicalShare * 0.65 + emaShare * 0.35;
  if (lastShare != null) return historicalShare * 0.75 + lastShare * 0.25;
  return historicalShare;
};

const buildHistoricalRatios = (rows: BreakdownRow[]) => {
  const sums = new Map<RatioKey, { contentShareSum: number; count: number }>();
  const global = new Map<V9BreakdownCaption, { contentShareSum: number; count: number }>();

  for (const row of rows) {
    if (row.split !== 'train') continue;
    const target = JSON.parse(row.y_subcaption_json) as Record<
      V9BreakdownCaption,
      { content: number; achievement: number }
    >;
    const mask = JSON.parse(row.y_subcaption_mask_json) as Record<
      V9BreakdownCaption,
      { pair: boolean }
    >;

    for (const caption of V9_BREAKDOWN_CAPTIONS) {
      if (!mask[caption]?.pair) continue;
      const pair = target[caption];
      const total = (pair?.content ?? 0) + (pair?.achievement ?? 0);
      if (total <= 0) continue;
      const share = (pair?.content ?? 0) / total;

      const key = ratioKey(row.division_name, caption);
      const current = sums.get(key) ?? { contentShareSum: 0, count: 0 };
      current.contentShareSum += share;
      current.count += 1;
      sums.set(key, current);

      const globalCurrent = global.get(caption) ?? { contentShareSum: 0, count: 0 };
      globalCurrent.contentShareSum += share;
      globalCurrent.count += 1;
      global.set(caption, globalCurrent);
    }
  }

  return {
    lookup: (division: string, caption: V9BreakdownCaption) => {
      const scoped = sums.get(ratioKey(division, caption));
      if (scoped?.count) return scoped.contentShareSum / scoped.count;
      const fallback = global.get(caption);
      if (fallback?.count) return fallback.contentShareSum / fallback.count;
      return 0.5;
    },
    by_division_caption: Object.fromEntries(
      [...sums.entries()].map(([key, value]) => [
        key,
        { content_share: value.contentShareSum / value.count, count: value.count },
      ])
    ),
  };
};

const main = async () => {
  const args = parseArgs();
  const client = createClient({ url: `file:${args.dbPath}` });
  const result = await client.execute({
    sql: `
      SELECT division_name, split, anchor_mode, x_static_json, v9_pred_recap_json,
             y_subcaption_json, y_subcaption_mask_json
      FROM ml_sequence_rows_v9_breakdown
      WHERE source_v9_model_id = ?
    `,
    args: [args.sourceModelId],
  });
  const rows = result.rows as unknown as BreakdownRow[];
  const ratios = buildHistoricalRatios(rows);

  const models = ['fixed_50_50', 'historical_ratio', 'blended_prior_ratio'] as const;
  const overall = Object.fromEntries(models.map((model) => [model, emptyMetrics()])) as Record<
    (typeof models)[number],
    MetricAccumulator
  >;
  const byAnchorMode: Record<string, Record<string, MetricAccumulator>> = {};
  const byCaption: Record<string, Record<string, MetricAccumulator>> = {};
  const byDivision: Record<string, Record<string, MetricAccumulator>> = {};

  const ensureNested = (target: Record<string, Record<string, MetricAccumulator>>, key: string) => {
    target[key] ??= Object.fromEntries(models.map((model) => [model, emptyMetrics()])) as Record<
      string,
      MetricAccumulator
    >;
    return target[key]!;
  };

  for (const row of rows) {
    const anchor = JSON.parse(row.v9_pred_recap_json) as Record<V9BreakdownCaption, number>;
    const staticFeatures = JSON.parse(row.x_static_json) as number[];
    const target = JSON.parse(row.y_subcaption_json) as Record<
      V9BreakdownCaption,
      { content: number; achievement: number }
    >;
    const mask = JSON.parse(row.y_subcaption_mask_json) as Record<
      V9BreakdownCaption,
      { pair: boolean }
    >;

    for (const caption of V9_BREAKDOWN_CAPTIONS) {
      if (!mask[caption]?.pair) continue;
      const anchorTotal = Number(anchor[caption] ?? 0);
      if (anchorTotal <= 0) continue;
      const targetPair = target[caption];
      if (!targetPair) continue;

      const predictions = {
        fixed_50_50: {
          content: anchorTotal / 2,
          achievement: anchorTotal / 2,
        },
        historical_ratio: (() => {
          const share = ratios.lookup(row.division_name, caption);
          return {
            content: anchorTotal * share,
            achievement: anchorTotal * (1 - share),
          };
        })(),
        blended_prior_ratio: (() => {
          const historicalShare = ratios.lookup(row.division_name, caption);
          const share = blendedPriorShare(
            historicalShare,
            staticFeatures,
            V9_BREAKDOWN_CAPTIONS.indexOf(caption)
          );
          return {
            content: anchorTotal * share,
            achievement: anchorTotal * (1 - share),
          };
        })(),
      };

      for (const model of models) {
        addMetric(overall[model], predictions[model], targetPair, anchorTotal);
        addMetric(ensureNested(byAnchorMode, row.anchor_mode)[model], predictions[model], targetPair, anchorTotal);
        addMetric(ensureNested(byCaption, caption)[model], predictions[model], targetPair, anchorTotal);
        addMetric(ensureNested(byDivision, row.division_name)[model], predictions[model], targetPair, anchorTotal);
      }
    }
  }

  const finishNested = (target: Record<string, Record<string, MetricAccumulator>>) =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        Object.fromEntries(Object.entries(value).map(([model, acc]) => [model, finish(acc)])),
      ])
    );

  const report = {
    generated_at: new Date().toISOString(),
    db_path: args.dbPath,
    source_v9_model_id: args.sourceModelId,
    row_count: rows.length,
    ratio_priors: ratios.by_division_caption,
    overall: Object.fromEntries(models.map((model) => [model, finish(overall[model])])),
    by_anchor_mode: finishNested(byAnchorMode),
    by_caption: finishNested(byCaption),
    by_division: finishNested(byDivision),
  };

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`V9 breakdown baseline evaluation written to ${args.output}`);
  for (const model of models) {
    const metrics = report.overall[model];
    console.log(
      `${model}: subcaption_mae=${metrics.subcaption_mae_pts?.toFixed(4)} content_share_mae=${metrics.content_share_mae?.toFixed(4)}`
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
