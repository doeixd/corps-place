import { describe, it, expect } from 'vite-plus/test';
import { parseMetric, parseDivs, parseRecency } from './codec';

describe('rankings codec', () => {
  it('parseMetric: known metrics pass, others drop', () => {
    expect(parseMetric('ge')).toBe('ge');
    expect(parseMetric('total')).toBe('total');
    expect(parseMetric('bogus')).toBeUndefined();
    expect(parseMetric(undefined)).toBeUndefined();
  });

  it('parseDivs: accepts array OR comma-string, keeps only valid', () => {
    expect(parseDivs('world,open')).toEqual(['world', 'open']);
    expect(parseDivs(['open', 'all-age'])).toEqual(['open', 'all-age']);
    expect(parseDivs('world,nope')).toEqual(['world']);
    expect(parseDivs('nope')).toBeUndefined();
    expect(parseDivs('')).toBeUndefined();
    expect(parseDivs(undefined)).toBeUndefined();
  });

  it('parseRecency: exactly 3 positive days, ascending; else undefined', () => {
    expect(parseRecency('7,14,28')).toEqual([7, 14, 28]);
    expect(parseRecency('28,7,14')).toEqual([7, 14, 28]); // sorted
    expect(parseRecency(['10', '20', '30'])).toEqual([10, 20, 30]);
    expect(parseRecency('7,14')).toBeUndefined(); // not 3
    expect(parseRecency('7,-1,14,28')).toEqual([7, 14, 28]); // negative dropped → 3 remain
    expect(parseRecency('1,2')).toBeUndefined();
    expect(parseRecency(undefined)).toBeUndefined();
  });
});
