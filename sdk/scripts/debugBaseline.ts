import { createClient } from '@libsql/client';
import {
  buildV9PredictionFeatures,
  totalFromV9Captions,
} from '../src/training/v9PredictionFeatures.js';

async function main() {
  const db = createClient({ url: 'file:./dci-relational.db' });

  for (const corps of [
    { key: '001j000000i6i9saav', name: 'Blue Devils' },
    { key: '001j000000h3xrnaav', name: 'Phantom Regiment' },
    { key: '001j000000iwwsoaal', name: 'Blue Knights' },
    { key: '001j000000iwxajaa1', name: 'Troopers' },
    { key: '001j000000iwx9oaad', name: 'Genesis' },
  ]) {
    const features = await buildV9PredictionFeatures(db, {
      mode: 'preseason_forecast',
      corpsKey: corps.key,
      division: 'World Class',
      targetDate: '2026-06-27',
      percentThrough: 13.7,
      season: '2026',
      fieldSize: 5,
      keepKnownLineupContext: false,
    });

    console.log(
      `${corps.name}: baselineTotal=${totalFromV9Captions(features.baseline.captions).toFixed(2)}, rank=${features.baseline.rank}, source=${features.baseline.rankSource}, confidence=${features.baseline.confidence}`
    );
    console.log(
      `  template: ${features.provenance.template.source}, slug: ${features.provenance.template.competitionSlug}`
    );
  }

  db.close();
}

main().catch(console.error);
