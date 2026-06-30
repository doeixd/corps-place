import { describe, it, expect } from 'vite-plus/test';
import { encodeVsSeries, decodeVsSeries, vsSeriesToken } from './codec';
import type { VsSeries } from './types';

describe('vs codec', () => {
  const sample: VsSeries[] = [
    { kind: 'corps', corpsSlug: 'blue-devils', season: '2026' },
    { kind: 'corps', corpsSlug: 'blue-devils', season: '2025' },
    { kind: 'baseline', rank: 13 },
    { kind: 'prediction', corpsSlug: 'bluecoats', asOf: '2026-06-01' },
    { kind: 'predicted', corpsSlug: 'cavaliers' },
  ];

  it('round-trips decode(encode(x)) === x', () => {
    expect(decodeVsSeries(encodeVsSeries(sample))).toEqual(sample);
  });

  it('encodes the documented shape', () => {
    expect(encodeVsSeries(sample)).toBe(
      'corps~blue-devils~2026,corps~blue-devils~2025,baseline~13,pred~bluecoats~2026-06-01,forecast~cavaliers'
    );
  });

  it('drops malformed tokens without throwing', () => {
    expect(decodeVsSeries('corps~blue-devils~2026,garbage,baseline~99,corps~~2026,pred~x')).toEqual([
      { kind: 'corps', corpsSlug: 'blue-devils', season: '2026' },
    ]);
  });

  it('dedupes repeated tokens', () => {
    expect(decodeVsSeries('baseline~1,baseline~1,corps~bd~2025,corps~bd~2025')).toEqual([
      { kind: 'baseline', rank: 1 },
      { kind: 'corps', corpsSlug: 'bd', season: '2025' },
    ]);
  });

  it('caps at VS_SERIES_CAP (6)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `baseline~${i + 1}`).join(',');
    expect(decodeVsSeries(many)).toHaveLength(6);
  });

  it('empty / nullish → []', () => {
    expect(decodeVsSeries('')).toEqual([]);
    expect(decodeVsSeries(null)).toEqual([]);
    expect(decodeVsSeries(undefined)).toEqual([]);
  });

  it('rejects out-of-range baseline ranks', () => {
    expect(vsSeriesToken({ kind: 'baseline', rank: 26 })).toBeNull();
    expect(vsSeriesToken({ kind: 'baseline', rank: 0 })).toBeNull();
  });
});
