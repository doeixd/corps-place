import { writeFileSync } from 'node:fs';
import { renderOgPng } from '../../app/lib/og/render';
import { ScoreCard, SeasonCard, ShowCard } from '../../app/lib/og/templates';

const score = await renderOgPng(
  ScoreCard({
    title: 'DCI World Championship Finals',
    sub: '2024 · Aug 10, 2024 · Indianapolis, IN',
    podium: [
      { corps: 'Blue Devils', score: '98.500' },
      { corps: 'Bluecoats', score: '97.800' },
      { corps: 'Carolina Crown', score: '97.100' },
    ],
  })
);
writeFileSync('/tmp/og-score.png', score);
console.error('score png:', score.length, 'bytes');

const season = await renderOgPng(SeasonCard({ season: '2025', count: 42 }));
writeFileSync('/tmp/og-season.png', season);
console.error('season png:', season.length, 'bytes');

const show = await renderOgPng(
  ShowCard({ corps: 'Blue Devils', season: '2024', title: 'The Romantics', sub: 'A program about love' })
);
writeFileSync('/tmp/og-show.png', show);
console.error('show png:', show.length, 'bytes');
