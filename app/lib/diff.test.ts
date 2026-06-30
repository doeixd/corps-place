import { describe, expect, it } from 'vite-plus/test';
import { computeDiff, DIFF_CAPTION_KEYS, type DiffRow } from './diff';
import type { RecapRow } from './prediction-scenario';

const row = (corps_key: string, fields: Partial<RecapRow>): RecapRow => ({
  corps_key,
  ...fields,
});

const find = (rows: DiffRow[], key: string) => rows.find((r) => r.corps_key === key)!;

describe('computeDiff', () => {
  it('diffs matching corps per subcaption and derives aggregates', () => {
    const scored = [
      row('a', { corps: 'Alpha', GE1: 19.5, GE2: 19.0, VP: 18.0, VA: 18.0, CG: 18.0, MB: 19.0, MA: 18.5, MP: 18.5 }),
    ];
    const predicted = [
      row('a', { corps: 'Alpha', GE1: 19.0, GE2: 19.0, VP: 18.0, VA: 17.0, CG: 18.0, MB: 18.0, MA: 18.5, MP: 18.5 }),
    ];
    const [d] = computeDiff(scored, predicted);
    expect(d.corps_key).toBe('a');
    expect(d.name).toBe('Alpha');
    expect(d.captions.GE1.diff).toBe(0.5);
    expect(d.captions.GE2.diff).toBe(0);
    expect(d.captions.VA.diff).toBe(1);
    expect(d.captions.MB.diff).toBe(1);
    // ge = ge1+ge2: scored 38.5, predicted 38.0 -> diff 0.5
    expect(d.ge.scored).toBe(38.5);
    expect(d.ge.predicted).toBe(38);
    expect(d.ge.diff).toBe(0.5);
    // visual = (vp+va+cg)/2: scored (54)/2=27, predicted (53)/2=26.5 -> 0.5
    expect(d.visual.diff).toBe(0.5);
    // music = (mb+ma+mp)/2: scored (56)/2=28, predicted (55)/2=27.5 -> 0.5
    expect(d.music.diff).toBe(0.5);
    expect(d.total.diff).toBe(1.5);
  });

  it('marks corps only in scores with null predicted/diff', () => {
    const scored = [row('x', { corps: 'X', GE1: 19, GE2: 19 })];
    const rows = computeDiff(scored, []);
    const d = find(rows, 'x');
    expect(d.captions.GE1.scored).toBe(19);
    expect(d.captions.GE1.predicted).toBe(null);
    expect(d.captions.GE1.diff).toBe(null);
    expect(d.ge.scored).toBe(38);
    expect(d.ge.predicted).toBe(null);
    expect(d.ge.diff).toBe(null);
    expect(d.total.diff).toBe(null);
  });

  it('marks corps only in prediction with null scored/diff', () => {
    const predicted = [row('y', { corps: 'Y', GE1: 18, GE2: 18 })];
    const rows = computeDiff([], predicted);
    const d = find(rows, 'y');
    expect(d.captions.GE1.predicted).toBe(18);
    expect(d.captions.GE1.scored).toBe(null);
    expect(d.captions.GE1.diff).toBe(null);
    expect(d.ge.predicted).toBe(36);
    expect(d.ge.scored).toBe(null);
  });

  it('handles partial subcaption data on one side', () => {
    const scored = [row('p', { corps: 'P', GE1: 19, VP: 18 })];
    const predicted = [row('p', { corps: 'P', GE1: 18.5, GE2: 18 })];
    const [d] = computeDiff(scored, predicted);
    // GE1 present both sides
    expect(d.captions.GE1.diff).toBe(0.5);
    // GE2 only predicted -> diff null
    expect(d.captions.GE2.scored).toBe(null);
    expect(d.captions.GE2.diff).toBe(null);
    // VP only scored -> diff null
    expect(d.captions.VP.predicted).toBe(null);
    expect(d.captions.VP.diff).toBe(null);
    // ge requires ALL contributing subcaptions: scored has GE1 only (GE2 missing)
    // -> null; predicted has GE1+GE2 -> 36.5. A partial aggregate is unavailable,
    // so the diff is null rather than a misleading 19-vs-36.5 "miss".
    expect(d.ge.scored).toBe(null);
    expect(d.ge.predicted).toBe(36.5);
    expect(d.ge.diff).toBe(null);
  });

  it('full outer join preserves scored order then predicted-only', () => {
    const scored = [row('a', { corps: 'A' }), row('b', { corps: 'B' })];
    const predicted = [row('b', { corps: 'B' }), row('c', { corps: 'C' })];
    const rows = computeDiff(scored, predicted);
    expect(rows.map((r) => r.corps_key)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for empty inputs', () => {
    expect(computeDiff([], [])).toEqual([]);
  });

  it('exposes diff caption keys (8 subcaptions + total)', () => {
    expect(DIFF_CAPTION_KEYS).toEqual(['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP', 'total']);
  });
});
