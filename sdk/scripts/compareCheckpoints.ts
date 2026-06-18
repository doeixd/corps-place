import '@tensorflow/tfjs-node';
import { createClient } from '@libsql/client';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';
import { loadV9SubcaptionModel } from '../src/training/v9SubcaptionInference.js';
import type { V9SubcaptionCheckpoint } from '../src/training/v9SubcaptionInference.js';

const CHECKPOINTS: V9SubcaptionCheckpoint[] = [
  'best',
  'best_composite',
  'best_loss',
  'best_phase_a',
  'best_phase_b',
  'best_phase_c',
  'best_total',
];

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

  console.log('=== Predictions by Checkpoint (Delta+Baseline) ===\n');

  for (const checkpoint of CHECKPOINTS) {
    console.log(`--- Checkpoint: ${checkpoint} ---`);
    const model = await loadV9SubcaptionModel(modelDir, { checkpoint });

    const rows = [];
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
        keepKnownLineupContext: true,
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

      rows.push({
        corps: corps.name,
        total: Number(prediction.total.toFixed(2)),
        ge: Number(prediction.categories.ge.toFixed(2)),
        visual: Number(prediction.categories.visual.toFixed(2)),
        music: Number(prediction.categories.music.toFixed(2)),
        baselineTotal: Number(totalFromV9Captions(features.baseline.captions).toFixed(2)),
      });
    }

    rows.sort((a, b) => b.total - a.total);
    console.table(rows);
    console.log();
    model.dispose();
  }

  db.close();
}

main().catch(console.error);
