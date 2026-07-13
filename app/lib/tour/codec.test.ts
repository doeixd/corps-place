import { describe, it, expect } from 'vite-plus/test';
import {
  parseCorpsList,
  parseTourDivs,
  parseTourAsof,
  parseTourYear,
  tourCanonicalPath,
  TOUR_FOCUS_CAP,
} from './codec';

describe('tour codec', () => {
  it('parseCorpsList: dedupes, lowercases, drops junk, caps', () => {
    expect(parseCorpsList('blue-devils,bluecoats,Blue-Devils')).toEqual([
      'blue-devils',
      'bluecoats',
    ]);
    expect(parseCorpsList(['a', '../etc', 'b b', 'ok-2'])).toEqual(['a', 'ok-2']);
    expect(parseCorpsList('')).toBeUndefined();
    expect(parseCorpsList(undefined)).toBeUndefined();
    const many = Array.from({ length: 20 }, (_, i) => `c${i}`).join(',');
    expect(parseCorpsList(many)!.length).toBe(TOUR_FOCUS_CAP);
  });

  it('parseTourDivs: keeps valid categories incl. soundsport, else undefined', () => {
    expect(parseTourDivs('world,soundsport')).toEqual(['world', 'soundsport']);
    expect(parseTourDivs('bogus')).toBeUndefined();
    expect(parseTourDivs(['open', 'open'])).toEqual(['open']);
  });

  it('parseTourAsof: strict YYYY-MM-DD', () => {
    expect(parseTourAsof('2026-07-04')).toBe('2026-07-04');
    expect(parseTourAsof('2026-7-4')).toBeUndefined();
    expect(parseTourAsof(20260704)).toBeUndefined();
  });

  it('parseTourYear: plausible seasons only, coerces numbers', () => {
    expect(parseTourYear('2026')).toBe('2026');
    expect(parseTourYear(2023)).toBe('2023');
    expect(parseTourYear('999')).toBeUndefined();
    expect(parseTourYear('twenty')).toBeUndefined();
  });

  it('tourCanonicalPath: newest → bare /tour, else /tour/<year>', () => {
    expect(tourCanonicalPath('2026', '2026')).toBe('/tour');
    expect(tourCanonicalPath('2023', '2026')).toBe('/tour/2023');
  });
});
