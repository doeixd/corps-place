import { describe, expect, it } from 'vite-plus/test';
import {
  buildActualStandings,
  buildConsensus,
  gradeOrdering,
  median,
  pickPoints,
  type PriorFinalsRow,
} from './ballot-grading';

const row = (key: string, caption: string, score: number): PriorFinalsRow => ({
  corps_key: key,
  caption_name: caption,
  score,
});

// Three corps, full captions — bd > bc > sc by the DCI total formula.
const CAPTIONS = [
  'General Effect 1',
  'General Effect 2',
  'Visual Proficiency',
  'Visual - Analysis',
  'Color Guard',
  'Music - Brass',
  'Music - Analysis',
  'Music - Percussion',
];
const rows: PriorFinalsRow[] = [
  ...CAPTIONS.map((c) => row('k-bd', c, 19)),
  ...CAPTIONS.map((c) => row('k-bc', c, 18)),
  ...CAPTIONS.map((c) => row('k-sc', c, 17)),
  // sc beats bc in Color Guard despite the lower total.
  row('k-sc', 'Color Guard', 19.5),
];
const keyToSlug = new Map([
  ['k-bd', 'blue-devils'],
  ['k-bc', 'bluecoats'],
  ['k-sc', 'santa-clara-vanguard'],
]);

describe('buildActualStandings', () => {
  const s = buildActualStandings(rows, keyToSlug);

  it('ranks overall by the DCI total formula, keyed by slug', () => {
    expect(s.overall.get('blue-devils')).toBe(1);
    expect(s.overall.get('bluecoats')).toBe(2);
    expect(s.overall.get('santa-clara-vanguard')).toBe(3);
    expect(s.fieldSize).toBe(3);
  });

  it('ranks captions independently (duplicate caption rows: last write wins)', () => {
    expect(s.captions.CG.get('santa-clara-vanguard')).toBe(1);
    expect(s.captions.CG.get('blue-devils')).toBe(2);
    expect(s.captions.MB.get('blue-devils')).toBe(1);
  });

  it('falls back to the corps_key when no slug is mapped', () => {
    const s2 = buildActualStandings(rows, new Map());
    expect(s2.overall.get('k-bd')).toBe(1);
  });
});

describe('pickPoints / gradeOrdering', () => {
  it('scores 10 exact, decays 3 per position, floors at 0', () => {
    expect(pickPoints(0)).toBe(10);
    expect(pickPoints(1)).toBe(7);
    expect(pickPoints(-2)).toBe(4);
    expect(pickPoints(3)).toBe(1);
    expect(pickPoints(4)).toBe(0);
    expect(pickPoints(9)).toBe(0);
  });

  it('grades a perfect ballot at 100%', () => {
    const actual = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const g = gradeOrdering(['a', 'b', 'c'], actual);
    expect(g.earned).toBe(30);
    expect(g.pct).toBe(100);
    expect(g.exact).toBe(3);
  });

  it('handles swaps and corps missing from the field', () => {
    const actual = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const g = gradeOrdering(['b', 'a', 'ghost'], actual);
    // b predicted 1 actual 2 → 7; a predicted 2 actual 1 → 7; ghost → 0.
    expect(g.picks.map((p) => p.points)).toEqual([7, 7, 0]);
    expect(g.picks[2]).toMatchObject({ actual: null, delta: null });
    expect(g.pct).toBe(46.7);
  });
});

describe('median / buildConsensus', () => {
  it('computes true medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('aggregates median predicted position across ballots', () => {
    const ballots = [
      {
        overall: [
          { slug: 'a', name: 'A' },
          { slug: 'b', name: 'B' },
        ],
      },
      {
        overall: [
          { slug: 'b', name: 'B' },
          { slug: 'a', name: 'A' },
        ],
      },
      { overall: [{ slug: 'a', name: 'A' }] },
    ];
    const rows = buildConsensus(ballots, new Map([['a', 2]]));
    expect(rows[0]).toMatchObject({ slug: 'a', medianPredicted: 1, appearances: 3, actual: 2 });
    expect(rows[1]).toMatchObject({
      slug: 'b',
      medianPredicted: 1.5,
      appearances: 2,
      actual: null,
    });
  });
});
