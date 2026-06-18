import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
  type V9BreakdownPair,
} from '../src/training/v9BreakdownData.js';
import {
  V9_BREAKDOWN_SPLIT_CURVE_VERSION,
  clampV9BreakdownPercentThroughSeason,
  normalizeV9BreakdownDivisionName,
  predictV9BreakdownContentShare,
  splitV9CaptionScoreWithContentShare,
  validateV9BreakdownSplitCurveArtifact,
  v9BreakdownDivisionCaptionKey,
  type V9BreakdownSplitCurve,
  type V9BreakdownSplitCurveArtifact,
  type V9BreakdownSplitCurvePoint,
} from '../src/training/v9BreakdownSplitCurves.js';

type BreakdownTableRow = {
  season: string;
  competition_slug: string;
  competition_date: string;
  division_name: string;
  corps_key: string;
  split: string;
  source_v9_model_id: string;
  anchor_mode: string;
  created_at?: string;
  y_caption_json: string;
  y_subcaption_json: string;
  y_subcaption_mask_json: string;
};

type TrainingPair = {
  season: string;
  competitionDateMs: number;
  divisionName: string;
  caption: V9BreakdownCaption;
  captionTotal: number;
  target: V9BreakdownPair;
  contentShare: number;
  percentThroughSeason: number;
  split: string;
};

type BucketAccumulator = {
  values: number[];
  count: number;
};

type SourceSelection = {
  sourceModelId: string;
  anchorMode: string;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const has = (name: string) => args.includes(name);
  const get = (name: string, fallback?: string) => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  return {
    dbPath: get('--db', 'dci-relational.db')!,
    output: get('--output', 'results/v9-breakdown-split-curves.json')!,
    sourceModelId: get('--source-model-id'),
    anchorMode: get('--anchor-mode'),
    bucketSize: Number(get('--bucket-size', '10')),
    minShare: Number(get('--min-share', '0.49')),
    maxShare: Number(get('--max-share', '0.53')),
    divisionCaptionPrior: Number(get('--division-caption-prior', '20')),
    captionPrior: Number(get('--caption-prior', '80')),
    divisionPrior: Number(get('--division-prior', '40')),
    globalPrior: Number(get('--global-prior', '80')),
    includeTestInArtifact: has('--include-test-in-artifact'),
  };
};

const resolveSourceSelection = async (
  client: ReturnType<typeof createClient>,
  requested: { sourceModelId?: string; anchorMode?: string }
): Promise<SourceSelection> => {
  if (requested.sourceModelId && requested.anchorMode) {
    return { sourceModelId: requested.sourceModelId, anchorMode: requested.anchorMode };
  }

  if (requested.sourceModelId && !requested.anchorMode) {
    const modes = await client.execute({
      sql: `
        SELECT anchor_mode, COUNT(*) AS row_count
        FROM ml_sequence_rows_v9_breakdown
        WHERE source_v9_model_id = ?
        GROUP BY anchor_mode
        ORDER BY CASE WHEN anchor_mode = 'v9_predicted' THEN 0 ELSE 1 END, row_count DESC
      `,
      args: [requested.sourceModelId],
    });
    const mode = modes.rows[0]?.anchor_mode;
    if (!mode) throw new Error(`No breakdown rows found for source model ${requested.sourceModelId}.`);
    if (String(mode) !== 'v9_predicted') {
      throw new Error(
        `Source ${requested.sourceModelId} has no v9_predicted anchor rows. Pass --anchor-mode ${String(mode)} explicitly if this is intentional.`
      );
    }
    return { sourceModelId: requested.sourceModelId, anchorMode: String(mode) };
  }

  if (!requested.sourceModelId && requested.anchorMode) {
    throw new Error('--anchor-mode requires --source-model-id; refusing to aggregate across source V9 models.');
  }

  const candidates = await client.execute(`
    SELECT source_v9_model_id, anchor_mode, COUNT(*) AS row_count, MAX(created_at) AS latest_created_at
    FROM ml_sequence_rows_v9_breakdown
    WHERE source_v9_model_id LIKE 'v9-real-%'
      AND anchor_mode = 'v9_predicted'
    GROUP BY source_v9_model_id, anchor_mode
    ORDER BY latest_created_at DESC, row_count DESC
  `);
  const selected = candidates.rows[0];
  if (!selected) {
    throw new Error(
      'No real V9 v9_predicted breakdown source found. Pass --source-model-id and --anchor-mode explicitly.'
    );
  }

  return {
    sourceModelId: String(selected.source_v9_model_id),
    anchorMode: String(selected.anchor_mode),
  };
};

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const quantile = (sortedValues: readonly number[], q: number) => {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const ratio = index - lower;
  const left = sortedValues[lower] ?? sortedValues[0]!;
  const right = sortedValues[upper] ?? sortedValues[sortedValues.length - 1]!;
  return left + (right - left) * ratio;
};

const std = (values: readonly number[], average: number) => {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const bucketPercent = (percentThroughSeason: number, bucketSize: number) => {
  const clamped = clampV9BreakdownPercentThroughSeason(percentThroughSeason);
  return Math.min(100, Math.round(clamped / bucketSize) * bucketSize);
};

const seasonBounds = (rows: readonly BreakdownTableRow[]) => {
  const bounds = new Map<string, { min: number; max: number }>();
  for (const row of rows) {
    const timestamp = Date.parse(String(row.competition_date));
    if (!Number.isFinite(timestamp)) continue;
    const season = String(row.season);
    const current = bounds.get(season) ?? { min: timestamp, max: timestamp };
    current.min = Math.min(current.min, timestamp);
    current.max = Math.max(current.max, timestamp);
    bounds.set(season, current);
  }
  return bounds;
};

const percentThroughSeasonFromDate = (
  row: BreakdownTableRow,
  bounds: Map<string, { min: number; max: number }>
) => {
  const timestamp = Date.parse(String(row.competition_date));
  const season = bounds.get(String(row.season));
  if (!season || !Number.isFinite(timestamp) || season.max <= season.min) return 50;
  return ((timestamp - season.min) / (season.max - season.min)) * 100;
};

const addBucketValue = (
  buckets: Map<string, BucketAccumulator>,
  key: string,
  value: number
) => {
  const current = buckets.get(key) ?? { values: [], count: 0 };
  current.values.push(value);
  current.count += 1;
  buckets.set(key, current);
};

const buildRawCurves = (
  pairs: readonly TrainingPair[],
  bucketSize: number,
  keyForPair: (pair: TrainingPair) => string
) => {
  const totalByKey = new Map<string, BucketAccumulator>();
  const bucketByKey = new Map<string, BucketAccumulator>();

  for (const pair of pairs) {
    const key = keyForPair(pair);
    addBucketValue(totalByKey, key, pair.contentShare);
    addBucketValue(
      bucketByKey,
      `${key}|${bucketPercent(pair.percentThroughSeason, bucketSize)}`,
      pair.contentShare
    );
  }

  return { totalByKey, bucketByKey };
};

const summarizeBucket = (
  percentThroughSeason: number,
  acc: BucketAccumulator,
  contentShare: number
): V9BreakdownSplitCurvePoint => {
  const sortedValues = [...acc.values].sort((left, right) => left - right);
  const rawContentShare = mean(sortedValues);
  return {
    percentThroughSeason,
    contentShare: Number(contentShare.toFixed(6)),
    rawContentShare: Number(rawContentShare.toFixed(6)),
    count: acc.count,
    medianContentShare: Number(quantile(sortedValues, 0.5).toFixed(6)),
    stdContentShare: Number(std(sortedValues, rawContentShare).toFixed(6)),
    q10ContentShare: Number(quantile(sortedValues, 0.1).toFixed(6)),
    q90ContentShare: Number(quantile(sortedValues, 0.9).toFixed(6)),
  };
};

const finishCurve = (
  key: string,
  totalByKey: Map<string, BucketAccumulator>,
  bucketByKey: Map<string, BucketAccumulator>,
  bucketSize: number,
  smoothShare: (percentThroughSeason: number, rawShare: number, count: number) => number
): V9BreakdownSplitCurve | undefined => {
  const total = totalByKey.get(key);
  if (!total?.count) return undefined;

  const points: V9BreakdownSplitCurvePoint[] = [];
  for (let percent = 0; percent <= 100; percent += bucketSize) {
    const bucket = bucketByKey.get(`${key}|${percent}`);
    if (!bucket?.count) continue;
    const rawShare = mean(bucket.values);
    points.push(summarizeBucket(percent, bucket, smoothShare(percent, rawShare, bucket.count)));
  }

  return {
    count: total.count,
    contentShare: Number(mean(total.values).toFixed(6)),
    points,
  };
};

const buildArtifact = (
  trainPairs: readonly TrainingPair[],
  source: V9BreakdownSplitCurveArtifact['source'],
  config: V9BreakdownSplitCurveArtifact['config']
): V9BreakdownSplitCurveArtifact => {
  const globalRaw = buildRawCurves(trainPairs, config.bucketSize, () => 'global');
  const captionRaw = buildRawCurves(trainPairs, config.bucketSize, (pair) => pair.caption);
  const divisionRaw = buildRawCurves(trainPairs, config.bucketSize, (pair) => pair.divisionName);
  const divisionCaptionRaw = buildRawCurves(
    trainPairs,
    config.bucketSize,
    (pair) => v9BreakdownDivisionCaptionKey(pair.divisionName, pair.caption)
  );

  const global = finishCurve(
    'global',
    globalRaw.totalByKey,
    globalRaw.bucketByKey,
    config.bucketSize,
    (_percent, rawShare) => rawShare
  );
  if (!global) throw new Error('No usable global curve could be built.');

  const globalAt = (percent: number) => {
    const point = global.points.find((candidate) => candidate.percentThroughSeason === percent);
    return point?.contentShare ?? global.contentShare;
  };

  const byCaption = Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.flatMap((caption) => {
      const curve = finishCurve(
        caption,
        captionRaw.totalByKey,
        captionRaw.bucketByKey,
        config.bucketSize,
        (percent, rawShare, count) =>
          (rawShare * count + globalAt(percent) * config.globalPrior) /
          (count + config.globalPrior)
      );
      return curve ? [[caption, curve]] : [];
    })
  ) as Partial<Record<V9BreakdownCaption, V9BreakdownSplitCurve>>;

  const byDivision: Record<string, V9BreakdownSplitCurve> = {};
  for (const key of divisionRaw.totalByKey.keys()) {
    const curve = finishCurve(
      key,
      divisionRaw.totalByKey,
      divisionRaw.bucketByKey,
      config.bucketSize,
      (percent, rawShare, count) =>
        (rawShare * count + globalAt(percent) * config.globalPrior) /
        (count + config.globalPrior)
    );
    if (curve) byDivision[key] = curve;
  }

  const byDivisionCaption: Record<string, V9BreakdownSplitCurve> = {};
  for (const key of divisionCaptionRaw.totalByKey.keys()) {
    const [divisionName, caption] = key.split('|') as [string, V9BreakdownCaption];
    const curve = finishCurve(
      key,
      divisionCaptionRaw.totalByKey,
      divisionCaptionRaw.bucketByKey,
      config.bucketSize,
      (percent, rawShare, count) => {
        const captionShare =
          byCaption[caption]?.points.find((point) => point.percentThroughSeason === percent)
            ?.contentShare ??
          byCaption[caption]?.contentShare ??
          globalAt(percent);
        const divisionShare =
          byDivision[divisionName]?.points.find((point) => point.percentThroughSeason === percent)
            ?.contentShare ??
          byDivision[divisionName]?.contentShare ??
          globalAt(percent);
        const globalShare = globalAt(percent);
        const numerator =
          rawShare * count +
          captionShare * config.captionPrior +
          divisionShare * config.divisionPrior +
          globalShare * config.globalPrior;
        const denominator = count + config.captionPrior + config.divisionPrior + config.globalPrior;
        return numerator / denominator;
      }
    );
    if (curve) byDivisionCaption[key] = curve;
  }

  return {
    version: V9_BREAKDOWN_SPLIT_CURVE_VERSION,
    generatedAt: new Date().toISOString(),
    source,
    config,
    global,
    byCaption,
    byDivision,
    byDivisionCaption,
  };
};

const parsePairs = (rows: readonly BreakdownTableRow[]) => {
  const bounds = seasonBounds(rows);
  const pairs: TrainingPair[] = [];

  for (const row of rows) {
    const divisionName = normalizeV9BreakdownDivisionName(row.division_name);
    const captionTotals = JSON.parse(String(row.y_caption_json)) as Record<string, number>;
    const targets = JSON.parse(String(row.y_subcaption_json)) as Record<
      V9BreakdownCaption,
      V9BreakdownPair
    >;
    const masks = JSON.parse(String(row.y_subcaption_mask_json)) as Record<
      V9BreakdownCaption,
      { pair?: boolean }
    >;
    const percentThroughSeason = percentThroughSeasonFromDate(row, bounds);

    for (const caption of V9_BREAKDOWN_CAPTIONS) {
      if (!masks[caption]?.pair) continue;
      const target = targets[caption];
      const captionTotal = Number(captionTotals[caption] ?? target.content + target.achievement);
      const targetTotal = Number(target.content) + Number(target.achievement);
      if (!Number.isFinite(captionTotal) || captionTotal <= 0 || !Number.isFinite(targetTotal) || targetTotal <= 0) {
        continue;
      }
      pairs.push({
        season: String(row.season),
        competitionDateMs: Date.parse(String(row.competition_date)),
        divisionName,
        caption,
        captionTotal,
        target,
        contentShare: target.content / targetTotal,
        percentThroughSeason,
        split: String(row.split),
      });
    }
  }

  return pairs;
};

const evaluate = (
  artifact: V9BreakdownSplitCurveArtifact,
  pairs: readonly TrainingPair[]
): NonNullable<V9BreakdownSplitCurveArtifact['evaluation']> => {
  let fixed50ShareAbs = 0;
  let curveShareAbs = 0;
  let fixed50SubcaptionAbs = 0;
  let curveSubcaptionAbs = 0;

  for (const pair of pairs) {
    const targetShare = pair.contentShare;
    const curveShare = predictV9BreakdownContentShare(artifact, pair);
    const fixed50 = splitV9CaptionScoreWithContentShare(pair.captionTotal, 0.5);
    const curve = splitV9CaptionScoreWithContentShare(pair.captionTotal, curveShare);
    fixed50ShareAbs += Math.abs(0.5 - targetShare);
    curveShareAbs += Math.abs(curveShare - targetShare);
    fixed50SubcaptionAbs +=
      Math.abs(fixed50.content - pair.target.content) +
      Math.abs(fixed50.achievement - pair.target.achievement);
    curveSubcaptionAbs +=
      Math.abs(curve.content - pair.target.content) +
      Math.abs(curve.achievement - pair.target.achievement);
  }

  const count = pairs.length;
  const fixed50SubcaptionMae = count ? fixed50SubcaptionAbs / (count * 2) : null;
  const curveSubcaptionMae = count ? curveSubcaptionAbs / (count * 2) : null;
  const improvement =
    fixed50SubcaptionMae != null && curveSubcaptionMae != null
      ? fixed50SubcaptionMae - curveSubcaptionMae
      : null;

  return {
    validationPairCount: count,
    fixed50ShareMae: count ? fixed50ShareAbs / count : null,
    curveShareMae: count ? curveShareAbs / count : null,
    fixed50SubcaptionMaePtsUsingActualCaptionTotal: fixed50SubcaptionMae,
    curveSubcaptionMaePtsUsingActualCaptionTotal: curveSubcaptionMae,
    improvementVs50Pts: improvement,
    improvementVs50Tenths: improvement == null ? null : improvement * 10,
  };
};

const main = async () => {
  const args = parseArgs();
  const client = createClient({ url: `file:${args.dbPath}` });
  const sourceSelection = await resolveSourceSelection(client, {
    sourceModelId: args.sourceModelId,
    anchorMode: args.anchorMode,
  });
  const result = await client.execute({
    sql: `
      SELECT season, competition_slug, competition_date, division_name, corps_key, split,
             source_v9_model_id, anchor_mode, y_caption_json, y_subcaption_json, y_subcaption_mask_json
      FROM ml_sequence_rows_v9_breakdown
      WHERE source_v9_model_id = ?
        AND anchor_mode = ?
      GROUP BY season, competition_slug, competition_date, division_name, corps_key, split,
               y_caption_json, y_subcaption_json, y_subcaption_mask_json
    `,
    args: [sourceSelection.sourceModelId, sourceSelection.anchorMode],
  });

  const rows = result.rows as unknown as BreakdownTableRow[];
  const pairs = parsePairs(rows);
  const trainPairs = pairs.filter((pair) =>
    args.includeTestInArtifact ? pair.split !== 'validation' : pair.split === 'train'
  );
  const validationPairs = pairs.filter((pair) => pair.split !== 'train');

  const artifact = buildArtifact(
    trainPairs,
    {
      dbPath: args.dbPath,
      sourceV9ModelId: sourceSelection.sourceModelId,
      anchorMode: sourceSelection.anchorMode,
      rowCount: rows.length,
      pairCount: pairs.length,
    },
    {
      bucketSize: args.bucketSize,
      minShare: args.minShare,
      maxShare: args.maxShare,
      divisionCaptionPrior: args.divisionCaptionPrior,
      captionPrior: args.captionPrior,
      divisionPrior: args.divisionPrior,
      globalPrior: args.globalPrior,
    }
  );
  artifact.evaluation = evaluate(artifact, validationPairs);
  validateV9BreakdownSplitCurveArtifact(artifact);

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));

  console.log(`V9 breakdown split curves written to ${args.output}`);
  console.log(`source=${sourceSelection.sourceModelId} anchor_mode=${sourceSelection.anchorMode}`);
  console.log(`rows=${rows.length} pairs=${pairs.length} train_pairs=${trainPairs.length}`);
  console.log(
    `global_share=${artifact.global.contentShare.toFixed(5)} curves=${Object.keys(artifact.byDivisionCaption).length}`
  );
  const evaluation = artifact.evaluation;
  console.log(
    `validation: curve_share_mae=${evaluation.curveShareMae?.toFixed(5)} fixed50_share_mae=${evaluation.fixed50ShareMae?.toFixed(5)} improvement=${evaluation.improvementVs50Pts?.toFixed(5)}pts/${evaluation.improvementVs50Tenths?.toFixed(3)}tenths`
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
