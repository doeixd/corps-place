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

  // Test with synthetic static + direct recap head
  console.log('=== Synthetic static + direct recap head ===');
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

    // Direct recap values are at indices 24-31
    const values = (model as any).model.predict([]); // Can't easily get raw outputs
    // Instead, just use the categories/total from predictOne
    console.log(
      `${corps.name}: total=${prediction.total.toFixed(2)}, baseline=${totalFromV9Captions(features.baseline.captions).toFixed(2)}`
    );
  }

  model.dispose();
  db.close();
}

main().catch(console.error);
