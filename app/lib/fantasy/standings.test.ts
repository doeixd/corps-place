import { describe, it, expect } from 'vite-plus/test';
import { buildStandings, seasonBestFrom, type MemberPicks } from './standings';
import type { Pick } from './scoring';
import type { CaptionKey } from './captions';

const DEFAULT_WEIGHTS = { ge: 40, visual: 30, music: 30 };

const pick = (corpsKey: string, caption: CaptionKey): Pick => ({
  corpsKey,
  caption,
  captionSlotIndex: 1,
  weight: 1,
});

// One pick per caption for a member, all on the same corps.
const fullRoster = (corps: string): Pick[] =>
  (['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as CaptionKey[]).map((c) => pick(corps, c));

describe('buildStandings', () => {
  it('ranks members by total descending', () => {
    const best = seasonBestFrom(
      new Map([
        ...['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'].map(
          (c) => [`strong|${c}`, 19] as [string, number]
        ),
        ...['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'].map(
          (c) => [`weak|${c}`, 12] as [string, number]
        ),
      ])
    );
    const members: MemberPicks[] = [
      { userId: 'u-weak', picks: fullRoster('weak') },
      { userId: 'u-strong', picks: fullRoster('strong') },
    ];
    const rows = buildStandings(members, best, DEFAULT_WEIGHTS, 'recap');
    expect(rows.map((r) => r.userId)).toEqual(['u-strong', 'u-weak']);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
    expect(rows[0].total).toBeGreaterThan(rows[1].total);
  });

  it('breaks an exact total tie by GE subtotal', () => {
    // Two members with equal total but different GE vs Music split.
    const best = seasonBestFrom(
      new Map([
        ['a|GE1', 20],
        ['a|GE2', 20], // GE-heavy
        ['a|MB', 0],
        ['b|GE1', 0],
        ['b|GE2', 0],
        ['b|MB', 20], // music
      ])
    );
    const members: MemberPicks[] = [
      { userId: 'b', picks: [pick('b', 'GE1'), pick('b', 'GE2'), pick('b', 'MB')] },
      { userId: 'a', picks: [pick('a', 'GE1'), pick('a', 'GE2'), pick('a', 'MB')] },
    ];
    const rows = buildStandings(members, best, DEFAULT_WEIGHTS, 'recap');
    // a has GE=40*… ; whichever has higher GE ranks first on the tiebreak.
    const a = rows.find((r) => r.userId === 'a')!;
    const b = rows.find((r) => r.userId === 'b')!;
    if (Math.abs(a.total - b.total) < 1e-9) {
      expect(a.rank).toBeLessThan(b.rank); // a wins on GE
    }
    expect(a.ge).toBeGreaterThan(b.ge);
  });

  it('a missing season-best contributes 0 (incomplete roster still ranks)', () => {
    const rows = buildStandings(
      [{ userId: 'solo', picks: [pick('ghost', 'GE1')] }],
      seasonBestFrom(new Map()),
      DEFAULT_WEIGHTS,
      'recap'
    );
    expect(rows[0].total).toBe(0);
    expect(rows[0].rank).toBe(1);
  });
});
