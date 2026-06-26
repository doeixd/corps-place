import { describe, it, expect } from 'vite-plus/test';
import { resolveRankings } from './resolve';
import type { RankingScoreRow } from '@sdk/src/readModel/builders/rankings.js';

const row = (corps: string, day: string, score: number, metric = 'total'): RankingScoreRow => ({
  season: '2024',
  competitionSlug: `c-${day}`,
  date: `2024-08-${day}T04:00:00.000Z`,
  corpsSlug: corps,
  corpsName: corps.toUpperCase(),
  division: 'World Class',
  metric: metric as RankingScoreRow['metric'],
  score,
});

const rows: RankingScoreRow[] = [
  row('a', '01', 80),
  row('a', '05', 90),
  row('a', '10', 85),
  row('b', '01', 82),
  row('b', '10', 88),
];

describe('resolveRankings', () => {
  it('best: max per corps, ranked desc, asof = latest day', () => {
    const r = resolveRankings(rows, { metric: 'total', agg: 'best', divisions: ['world'] });
    expect(r.rows.map((x) => x.corpsSlug)).toEqual(['a', 'b']); // a max 90 > b max 88
    expect(r.rows[0].score).toBe(90);
    expect(r.asof).toBe('2024-08-10');
  });

  it('as-of filters to shows on/before the date', () => {
    const r = resolveRankings(rows, {
      metric: 'total',
      agg: 'best',
      asof: '2024-08-01',
      divisions: ['world'],
    });
    expect(r.rows.map((x) => x.corpsSlug)).toEqual(['b', 'a']); // day 01: b=82 > a=80
    expect(r.rows[0].score).toBe(82);
  });

  it('last3: average of last ≤3 shows; <3 flagged partial', () => {
    const r = resolveRankings(rows, { metric: 'total', agg: 'last3', divisions: ['world'] });
    const a = r.rows.find((x) => x.corpsSlug === 'a')!;
    expect(a.score).toBeCloseTo((80 + 90 + 85) / 3);
    expect(a.partial).toBe(false);
    const b = r.rows.find((x) => x.corpsSlug === 'b')!;
    expect(b.partial).toBe(true); // only 2 shows
  });

  it('division filter excludes non-matching corps', () => {
    const r = resolveRankings(rows, { metric: 'total', agg: 'best', divisions: ['open'] });
    expect(r.rows).toHaveLength(0);
  });

  it('builds per-day bump history', () => {
    const r = resolveRankings(rows, { metric: 'total', agg: 'best', divisions: ['world'] });
    const a = r.rows.find((x) => x.corpsSlug === 'a')!;
    expect(a.history.map((h) => h.date)).toEqual(['2024-08-01', '2024-08-05', '2024-08-10']);
    expect(r.dates).toEqual(['2024-08-01', '2024-08-05', '2024-08-10']);
  });

  it('recency: daysSinceLast from last show to asof', () => {
    const r = resolveRankings(rows, { metric: 'total', agg: 'best', divisions: ['world'] });
    const a = r.rows.find((x) => x.corpsSlug === 'a')!;
    expect(a.lastPerformedDate).toBe('2024-08-10');
    expect(a.daysSinceLast).toBe(0);
  });
});
