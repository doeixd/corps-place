import { describe, expect, it } from 'vitest';
import { nameMatch, normalizeName } from './name-match';

describe('normalizeName', () => {
  it('lowercases, strips punctuation/diacritics, drops honorifics + suffixes', () => {
    expect(normalizeName('Dr. José Peña-García Jr.')).toEqual(['jose', 'pena', 'garcia']);
    expect(normalizeName('  THE  Michael  Gaines ')).toEqual(['michael', 'gaines']);
    expect(normalizeName(null)).toEqual([]);
  });
});

describe('nameMatch', () => {
  it('identical names → exact', () => {
    expect(nameMatch('Michael Gaines', 'Michael Gaines').match).toBe('exact');
  });
  it('reordered / extra middle name → exact or close (token overlap)', () => {
    expect(nameMatch('Michael Gaines', 'Michael J. Gaines').match).not.toBe('weak');
    expect(nameMatch('Gaines, Michael', 'Michael Gaines').match).toBe('exact');
  });
  it('minor typo → close (levenshtein carries it)', () => {
    expect(['exact', 'close']).toContain(nameMatch('Michael Gaines', 'Micheal Gaines').match);
  });
  it('nickname / different person → weak (routes to review)', () => {
    expect(nameMatch('Bob Smith', 'Robert Johnson').match).toBe('weak');
    expect(nameMatch('', 'Michael Gaines').match).toBe('weak');
  });
  it('score is in [0,1]', () => {
    const { score } = nameMatch('Michael Gaines', 'Michael Gaines');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
