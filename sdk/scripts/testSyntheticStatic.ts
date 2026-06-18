import '@tensorflow/tfjs-node';
import { createClient } from '@libsql/client';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';
import { loadV9SubcaptionModel } from '../src/training/v9SubcaptionInference.js';

const CORPS_LIST = [
  { key: '001j000000i6i9saav', name: 'Blue Devils', seed: 1 },
  { key: '001j000000h3xrnaav', name: 'Phantom Regiment', seed: 2 },
  { key: '001j000000iwwsoaal', name: 'Blue Knights', seed: 3 },
  { key: '001j000000iwxajaa1', name: 'Troopers', seed: 4 },
  { key: '001j000000iwx9oaad', name: 'Genesis', seed: 5 },
];

async function main() {
  const db = createClient({ url: 'file:./dci-relational.db' });
  const modelDir = 'models/v9_subcaption_fixed/v9_prod_actually_final_1779812116275';
  const model = await loadV9SubcaptionModel(modelDir);

  console.log('=== With template static (current behavior) ===');
  const rows1 = [];
  for (const corps of CORPS_LIST) {
    const features = await buildV9PredictionFeatures(db, {
      mode: 'preseason_forecast',
      corpsKey: corps.key,
      division: 'World Class',
      targetDate: '2026-06-27',
      percentThrough: 13.7,
      season: '2026',
      seedRank: corps.seed,
      fieldSize: 5,
      keepKnownLineupContext: false,
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
    rows1.push({
      corps: corps.name,
      total: Number(prediction.total.toFixed(2)),
      baseline: Number(totalFromV9Captions(features.baseline.captions).toFixed(2)),
    });
  }
  console.table(rows1);

  // Now rebuild static features from scratch, ignoring template
  console.log('\n=== With synthetic static (ignore template) ===');
  const rows2 = [];
  for (const corps of CORPS_LIST) {
    const features = await buildV9PredictionFeatures(db, {
      mode: 'preseason_forecast',
      corpsKey: corps.key,
      division: 'World Class',
      targetDate: '2026-06-27',
      percentThrough: 13.7,
      season: '2026',
      seedRank: corps.seed,
      fieldSize: 5,
      keepKnownLineupContext: false,
    });

    // Build synthetic static manually
    const { buildSyntheticStatic } = await import('../src/training/v9PredictionFeatures.js');
    const { getV9CaptionBaseline } = await import('../src/training/v9Baselines.js');
    const baseline = getV9CaptionBaseline({
      mode: 'preseason_forecast',
      division: 'World Class',
      percentThrough: 13.7,
      seedRank: corps.seed,
    });
    const synthetic = buildSyntheticStatic(
      {
        mode: 'preseason_forecast',
        corpsKey: corps.key,
        division: 'World Class',
        targetDate: '2026-06-27',
        percentThrough: 13.7,
        seedRank: corps.seed,
        fieldSize: 5,
      },
      baseline
    );

    const prediction = model.predictOne({
      sequence: features.sequence,
      staticFeatures: synthetic,
      judgeIndices: features.judgeIndices,
      corpsId: features.corpsId,
      baselineRecap: features.baselineRecap,
      judgeBiasScale: features.judgeBiasScale,
      corpsScale: features.corpsScale,
      agnosticShowId: features.agnosticShowId,
    });
    rows2.push({
      corps: corps.name,
      total: Number(prediction.total.toFixed(2)),
      baseline: Number(totalFromV9Captions(baseline.captions).toFixed(2)),
    });
  }
  console.table(rows2);

  model.dispose();
  db.close();
}

main().catch(console.error);
