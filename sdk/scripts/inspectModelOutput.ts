import '@tensorflow/tfjs-node';
import * as tf from '@tensorflow/tfjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@libsql/client';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';
import { loadV9SubcaptionModel } from '../src/training/v9SubcaptionInference.js';

async function main() {
  const db = createClient({ url: 'file:./dci-relational.db' });
  const modelDir = 'models/v9_subcaption_fixed/v9_prod_actually_final_1779812116275';
  const model = await loadV9SubcaptionModel(modelDir);

  const features = await buildV9PredictionFeatures(db, {
    mode: 'preseason_forecast',
    corpsKey: '001j000000i6i9saav', // Blue Devils
    division: 'World Class',
    targetDate: '2026-06-27',
    percentThrough: 13.7,
    season: '2026',
    seedRank: 1,
    fieldSize: 5,
    keepKnownLineupContext: true,
  });

  console.log('=== Baseline ===');
  console.log('Baseline captions:', features.baselineRecap);
  console.log('Baseline total:', totalFromV9Captions(features.baseline.captions));

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

  console.log('\n=== Model Output ===');
  console.log('Total:', prediction.total);
  console.log('Categories:', prediction.categories);

  for (const cap of ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const) {
    console.log(`${cap}:`, prediction.captions[cap]);
  }

  model.dispose();
  db.close();
}

main().catch(console.error);
