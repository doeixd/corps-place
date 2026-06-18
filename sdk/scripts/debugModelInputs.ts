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

  const features = await buildV9PredictionFeatures(db, {
    mode: 'preseason_forecast',
    corpsKey: CORPS_LIST[0]!.key,
    division: 'World Class',
    targetDate: '2026-06-27',
    percentThrough: 13.7,
    season: '2026',
    seedRank: CORPS_LIST[0]!.seed,
    fieldSize: 5,
    keepKnownLineupContext: false,
  });

  // Zero out all static features except baseline and rank
  const testStatic = new Array(features.staticFeatures.length).fill(0);
  // Keep rank-related and baseline features
  testStatic[0] = features.staticFeatures[0]!; // prevRank
  testStatic[2] = features.staticFeatures[2]!; // meanRank
  testStatic[8] = 0; // sequenceLength
  testStatic[9] = features.staticFeatures[0]!; // rankEma = prevRank
  testStatic[10] = 0; // residualEma
  testStatic[11] = 0; // residualSlope
  testStatic[12] = 0; // residualVolatility
  testStatic[13] = 0; // rankVsHistorical
  testStatic[15] = 1; // daysSinceLastMatch
  testStatic[16] = 0.5; // showsRemaining
  testStatic[17] = 5 / 25; // fieldSize
  testStatic[22] = 0; // topCorpsPresent
  testStatic[23] = features.staticFeatures[2]!; // divisionStrength
  // rankBaseline 121-128
  for (let i = 121; i <= 128; i++) {
    testStatic[i] = features.staticFeatures[i]!;
  }

  console.log('=== Original static features ===');
  const orig = model.predictOne({
    sequence: features.sequence,
    staticFeatures: features.staticFeatures,
    judgeIndices: features.judgeIndices,
    corpsId: features.corpsId,
    baselineRecap: features.baselineRecap,
    judgeBiasScale: features.judgeBiasScale,
    corpsScale: features.corpsScale,
    agnosticShowId: features.agnosticShowId,
  });
  console.log(
    'Total:',
    orig.total.toFixed(2),
    'Baseline:',
    totalFromV9Captions(features.baseline.captions).toFixed(2)
  );

  console.log('\n=== Zeroed opponent context ===');
  const zeroed = model.predictOne({
    sequence: features.sequence,
    staticFeatures: testStatic,
    judgeIndices: features.judgeIndices,
    corpsId: features.corpsId,
    baselineRecap: features.baselineRecap,
    judgeBiasScale: features.judgeBiasScale,
    corpsScale: features.corpsScale,
    agnosticShowId: features.agnosticShowId,
  });
  console.log('Total:', zeroed.total.toFixed(2));

  console.log('\n=== corpsScale = 0 ===');
  const noCorps = model.predictOne({
    sequence: features.sequence,
    staticFeatures: features.staticFeatures,
    judgeIndices: features.judgeIndices,
    corpsId: 0,
    baselineRecap: features.baselineRecap,
    judgeBiasScale: features.judgeBiasScale,
    corpsScale: 0,
    agnosticShowId: features.agnosticShowId,
  });
  console.log('Total:', noCorps.total.toFixed(2));

  console.log('\n=== Different corpsId (swap with Genesis) ===');
  const genesisFeatures = await buildV9PredictionFeatures(db, {
    mode: 'preseason_forecast',
    corpsKey: CORPS_LIST[4]!.key,
    division: 'World Class',
    targetDate: '2026-06-27',
    percentThrough: 13.7,
    season: '2026',
    seedRank: CORPS_LIST[4]!.seed,
    fieldSize: 5,
    keepKnownLineupContext: false,
  });
  const swap = model.predictOne({
    sequence: features.sequence,
    staticFeatures: features.staticFeatures,
    judgeIndices: features.judgeIndices,
    corpsId: genesisFeatures.corpsId,
    baselineRecap: features.baselineRecap,
    judgeBiasScale: features.judgeBiasScale,
    corpsScale: 1,
    agnosticShowId: features.agnosticShowId,
  });
  console.log('Total:', swap.total.toFixed(2), '(Blue Devils features, Genesis corpsId)');

  model.dispose();
  db.close();
}

main().catch(console.error);
