import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import {
  loadV9SubcaptionModel,
  CAPTIONS,
  type Caption,
} from '../src/training/v9SubcaptionInference.js';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';

const MODEL_DIR = 'models/v9_subcaption_fixed/v9fix_shared_datefwd_idfloor0_1779507573588';

const EVENT = {
  name: 'Drums Along the Rockies',
  slug: '2026-drums-along-the-rockies',
  date: '2026-06-27T00:00:00.000Z',
  division: 'World Class',
  percentThrough: 5,
  lineup: [
    { corps: 'Genesis', city: 'Austin, TX', key: '001j000000iwx9oaad', seedRank: 5 },
    { corps: 'Troopers', city: 'Casper, WY', key: '001j000000iwxajaa1', seedRank: 3 },
    { corps: 'Phantom Regiment', city: 'Rockford, IL', key: '001j000000h3xrnaav', seedRank: 2 },
    { corps: 'Blue Devils', city: 'Concord, CA', key: '001j000000i6i9saav', seedRank: 1 },
    { corps: 'Blue Knights', city: 'Denver, CO', key: '001j000000iwwsoaal', seedRank: 4 },
  ],
};

const main = async () => {
  const db = createClient({ url: 'file:dci-relational.db' });
  const model = await loadV9SubcaptionModel(MODEL_DIR);

  const rows = [];
  for (let index = 0; index < EVENT.lineup.length; index++) {
    const entry = EVENT.lineup[index]!;
    const features = await buildV9PredictionFeatures(db, {
      mode: 'preseason_forecast',
      corpsKey: entry.key,
      division: EVENT.division,
      targetDate: EVENT.date,
      percentThrough: EVENT.percentThrough,
      seedRank: entry.seedRank,
      fieldSize: EVENT.lineup.length,
      templateSeason: '2025',
    });

    const prediction = model.predictOne({
      sequence: features.sequence,
      staticFeatures: features.staticFeatures,
      judgeIndices: features.judgeIndices,
      corpsId: features.corpsId,
      baselineRecap: features.baselineRecap,
      judgeBiasScale: features.judgeBiasScale,
      corpsScale: features.corpsScale,
      agnosticShowId: features.agnosticShowId,
    });

    const rawCaps = Object.fromEntries(
      CAPTIONS.map((caption) => [caption, Number(prediction.captions[caption].p50.toFixed(3))])
    ) as Record<Caption, number>;
    const rawModelTotal = totalFromV9Captions(rawCaps);

    // First-show cross-season prediction is out-of-distribution for the v9 sequence model.
    // Use the learned/reference baseline as the opener point estimate and keep raw model output for audit.
    const caps = Object.fromEntries(
      CAPTIONS.map((caption) => [caption, Number(features.baseline.captions[caption].toFixed(3))])
    ) as Record<Caption, number>;
    const total = totalFromV9Captions(caps);
    rows.push({
      rank: 0,
      corps: entry.corps,
      city: entry.city,
      total: Number(total.toFixed(3)),
      GE: Number((caps.GE1 + caps.GE2).toFixed(3)),
      Visual: Number(((caps.VP + caps.VA + caps.CG) / 2).toFixed(3)),
      Music: Number(((caps.MB + caps.MA + caps.MP) / 2).toFixed(3)),
      ...caps,
      raw_model_total: Number(rawModelTotal.toFixed(3)),
      source_template: `${features.provenance.template.competitionSlug} (${features.provenance.template.yTotal})`,
      template_source: features.provenance.template.source,
      baseline_rank_source: features.baseline.rankSource,
      baseline_confidence: features.baseline.confidence,
      feature_mode: features.provenance.mode,
    });
  }

  model.dispose();
  db.close();

  rows.sort((a, b) => ((b as any).total ?? -Infinity) - ((a as any).total ?? -Infinity));
  rows.forEach((row, idx) => {
    if ('total' in row) (row as any).rank = idx + 1;
  });

  const output = {
    generated_at: new Date().toISOString(),
    event: EVENT,
    model_dir: MODEL_DIR,
    mode: 'panel_unknown_cross_season_opener_baseline_guarded',
    caveats: [
      'DCI Tour Preview and Bluecoats Opening Night are non-adjudicated and are intentionally not predicted.',
      'Judge assignments were not found on public DCI event pages, so judge inputs are unknown/zeroed.',
      'The v9 model was trained on same-season sequences; raw neural output is out-of-distribution for a first show after the offseason.',
      'Point estimates therefore use division/rank/5%-through-season baseline curves, with raw model totals retained for audit.',
    ],
    predictions: rows,
  };

  fs.mkdirSync('results/predictions', { recursive: true });
  fs.writeFileSync(
    'results/predictions/2026-opening-recap-predictions.json',
    JSON.stringify(output, null, 2)
  );
  console.table(
    rows.map((row: any) => ({
      rank: row.rank,
      corps: row.corps,
      total: row.total,
      GE: row.GE,
      Visual: row.Visual,
      Music: row.Music,
    }))
  );
  console.log('Wrote results/predictions/2026-opening-recap-predictions.json');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
