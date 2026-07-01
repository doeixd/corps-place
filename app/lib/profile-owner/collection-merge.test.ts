import { describe, expect, it } from 'vite-plus/test';
import {
  applyCollectionOps,
  awardKey,
  performedKey,
  assignmentKey,
  mergeProfileOverlay,
  scrapedFieldValue,
  type AwardItem,
  type CollectionOp,
  type ProfileOverlay,
} from './merge';

// A staff-ish profile with editable collections.
const base = () => ({
  display_name: 'Michael Gaines',
  biography: 'Scraped bio.',
  photo_url: null as string | null,
  bioFacts: {
    hometown: null as string | null,
    currentPosition: null as { title: string; org: string } | null,
    awards: [
      { name: 'DCI Hall of Fame', year: 2015 },
      { name: 'Best Percussion', year: 2009 },
    ] as readonly AwardItem[],
    performedOther: [] as readonly { group: string; startYear: number | null; endYear: number | null }[],
  },
});

const activeOverlay = (overrides: ProfileOverlay extends null ? never : NonNullable<ProfileOverlay>['overrides']): ProfileOverlay => ({
  claim: { status: 'active', name_match: 'exact' },
  amOwner: true,
  overrides,
});

const awardsOverride = (ops: CollectionOp[]): NonNullable<ProfileOverlay>['overrides'] => ({
  awards: { content: { ops }, diverged: false },
});

describe('applyCollectionOps', () => {
  const key = awardKey;
  const scraped: AwardItem[] = [
    { name: 'A', year: 2000 },
    { name: 'B', year: 2001 },
  ];

  it('returns a copy of scraped when there are no ops', () => {
    const out = applyCollectionOps(scraped, [], key);
    expect(out).toEqual(scraped);
    expect(out).not.toBe(scraped);
  });

  it('removes by key, adds appended, edits in place', () => {
    const ops: CollectionOp[] = [
      { op: 'remove', key: awardKey({ name: 'B', year: 2001 }) },
      { op: 'add', key: awardKey({ name: 'C', year: 2002 }), item: { name: 'C', year: 2002 } },
      { op: 'edit', key: awardKey({ name: 'A', year: 2000 }), item: { name: 'A', year: 1999 } },
    ];
    const out = applyCollectionOps(scraped, ops, key) as AwardItem[];
    expect(out.map((a) => a.name).sort()).toEqual(['A', 'C']);
    expect(out.find((a) => a.name === 'A')?.year).toBe(1999);
    // input untouched
    expect(scraped.find((a) => a.name === 'B')).toBeTruthy();
  });

  it('is order-stable: scraped survivors first, then owner additions', () => {
    const out = applyCollectionOps(
      scraped,
      [{ op: 'add', key: 'z', item: { name: 'Z', year: null } }],
      key
    ) as AwardItem[];
    expect(out.map((a) => a.name)).toEqual(['A', 'B', 'Z']);
  });
});

describe('stable identity keys', () => {
  it('awardKey normalizes name + folds year', () => {
    expect(awardKey({ name: '  DCI Hall of Fame ', year: 2015 })).toBe(
      awardKey({ name: 'dci hall of fame', year: 2015 })
    );
    expect(awardKey({ name: 'X', year: null })).not.toBe(awardKey({ name: 'X', year: 2000 }));
  });
  it('performed/assignment keys are coarse (survive title/format churn)', () => {
    expect(performedKey({ group: 'Star', startYear: 1993, endYear: 1994 })).toContain('perf:star:1993');
    expect(
      assignmentKey({
        corps_key: 'k1', corps_name: 'Cavaliers', corps_slug: null,
        season: '2011', title: 'Brass Caption Head', role_type: 'brass',
        start_year: null, end_year: null,
      })
    ).toBe('asn:k1:2011:brass:brass caption head');
  });
});

describe('mergeProfileOverlay — collections (P1)', () => {
  it('applies add/edit/remove award ops onto the scraped list', () => {
    const ops: CollectionOp[] = [
      { op: 'remove', key: awardKey({ name: 'Best Percussion', year: 2009 }) },
      { op: 'add', key: awardKey({ name: 'New Award', year: 2020 }), item: { name: 'New Award', year: 2020 } },
    ];
    const m = mergeProfileOverlay(base(), activeOverlay(awardsOverride(ops)));
    const names = (m.bioFacts.awards ?? []).map((a) => a.name);
    expect(names).toEqual(['DCI Hall of Fame', 'New Award']);
    expect(m.ownership?.edited).toContain('awards');
  });

  it('DURABILITY: a re-scrape that adds a new award still surfaces it alongside owner edits', () => {
    // The owner removed one award earlier; a later scrape introduces a brand-new one.
    const p = base();
    p.bioFacts = {
      ...p.bioFacts,
      awards: [
        { name: 'DCI Hall of Fame', year: 2015 },
        { name: 'Best Percussion', year: 2009 },
        { name: 'Freshly Scraped', year: 2026 }, // appeared after the owner's edit
      ],
    };
    const ops: CollectionOp[] = [
      { op: 'remove', key: awardKey({ name: 'Best Percussion', year: 2009 }) },
    ];
    const m = mergeProfileOverlay(p, activeOverlay(awardsOverride(ops)));
    const names = (m.bioFacts.awards ?? []).map((a) => a.name);
    // owner's removal sticks; the new scraped award is NOT hidden (Option B, not A).
    expect(names).toContain('Freshly Scraped');
    expect(names).not.toContain('Best Percussion');
  });

  it('a pending claim applies NO collection edits', () => {
    const m = mergeProfileOverlay(base(), {
      claim: { status: 'pending', name_match: 'weak' },
      overrides: awardsOverride([{ op: 'remove', key: awardKey({ name: 'DCI Hall of Fame', year: 2015 }) }]),
    });
    expect((m.bioFacts.awards ?? []).map((a) => a.name)).toContain('DCI Hall of Fame');
    expect(m.ownership?.pending).toBe(true);
  });

  it('does not mutate the input profile', () => {
    const p = base();
    const before = JSON.stringify(p);
    mergeProfileOverlay(p, activeOverlay(awardsOverride([{ op: 'add', key: 'x', item: { name: 'X', year: null } }])));
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('scrapedFieldValue — collection keys', () => {
  it('returns the scraped collection for awards/performed', () => {
    const p = base();
    expect(scrapedFieldValue(p, 'awards')).toEqual(p.bioFacts.awards);
    expect(scrapedFieldValue(p, 'performed')).toEqual([]);
  });
});
