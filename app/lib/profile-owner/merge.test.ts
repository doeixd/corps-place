import { describe, expect, it } from 'vite-plus/test';
import { mergeProfileOverlay, hashSource, scrapedFieldValue, type ProfileOverlay } from './merge';

const base = () => ({
  display_name: 'Michael Gaines',
  biography: 'Scraped bio.',
  photo_url: 'https://scraped/p.png',
  bioFacts: { hometown: 'Old Town', currentPosition: null as { title: string; org: string } | null },
});

describe('mergeProfileOverlay', () => {
  it('no overlay / no claim → unchanged', () => {
    const p = base();
    expect(mergeProfileOverlay(p, null)).toBe(p);
    expect(mergeProfileOverlay(p, { claim: null, overrides: {} })).toBe(p);
  });

  it('active claim applies overrides (override ?? scraped) + ownership', () => {
    const overlay: ProfileOverlay = {
      claim: { status: 'active', name_match: 'exact' },
      overrides: {
        biography: { content: { plain: 'Owner bio.' }, diverged: false },
        photo: { content: { url: 'https://owner/p.png' }, diverged: true },
        hometown: { content: 'New City', diverged: false },
      },
    };
    const m = mergeProfileOverlay(base(), overlay);
    expect(m.biography).toBe('Owner bio.');
    expect(m.photo_url).toBe('https://owner/p.png');
    expect(m.bioFacts.hometown).toBe('New City');
    expect(m.ownership).toEqual({
      claimed: true,
      pending: false,
      verified: true,
      mine: false,
      edited: ['biography', 'photo', 'hometown'],
      diverged: ['photo'],
    });
  });

  it('{removed:true} clears the field', () => {
    const m = mergeProfileOverlay(base(), {
      claim: { status: 'active', name_match: 'close' },
      overrides: { photo: { content: { removed: true }, diverged: false } },
    });
    expect(m.photo_url).toBeNull();
  });

  it('pending claim surfaces ownership but applies NO edits', () => {
    const m = mergeProfileOverlay(base(), {
      claim: { status: 'pending', name_match: 'weak' },
      overrides: { biography: { content: { plain: 'should not show' }, diverged: false } },
    });
    expect(m.biography).toBe('Scraped bio.');
    expect(m.ownership).toEqual({
      claimed: false,
      pending: true,
      verified: false,
      mine: false,
      edited: [],
      diverged: [],
    });
  });

  it('does not mutate the input', () => {
    const p = base();
    mergeProfileOverlay(p, {
      claim: { status: 'active', name_match: 'exact' },
      overrides: { biography: { content: 'x', diverged: false } },
    });
    expect(p.biography).toBe('Scraped bio.');
  });
});

describe('removal is honored for every field (incl current_position)', () => {
  it('clears current_position when the override is {removed:true}', () => {
    const p = base();
    p.bioFacts.currentPosition = { title: 'Brass Caption Head', org: 'Bluecoats' };
    const merged = mergeProfileOverlay(p, {
      claim: { status: 'active', name_match: 'exact' },
      overrides: { current_position: { content: { removed: true }, diverged: false } },
    });
    expect(merged.bioFacts.currentPosition).toBeNull();
  });
});

describe('source divergence primitives', () => {
  it('hashSource is stable and order-independent for equal values', () => {
    expect(hashSource('a')).toBe(hashSource('a'));
    expect(hashSource({ title: 't', org: 'o' })).toBe(hashSource({ title: 't', org: 'o' }));
    expect(hashSource(null)).toBe(hashSource(undefined)); // both normalize to null
  });

  it('hashSource changes when the value changes (divergence signal)', () => {
    expect(hashSource('Scraped bio.')).not.toBe(hashSource('Scraped bio (updated).'));
    expect(hashSource(null)).not.toBe(hashSource('now has a value'));
  });

  it('scrapedFieldValue maps each field key to the scraped value', () => {
    const p = base();
    expect(scrapedFieldValue(p, 'biography')).toBe('Scraped bio.');
    expect(scrapedFieldValue(p, 'photo')).toBe('https://scraped/p.png');
    expect(scrapedFieldValue(p, 'hometown')).toBe('Old Town');
    expect(scrapedFieldValue(p, 'current_position')).toBeNull();
    expect(scrapedFieldValue(p, 'unknown_field')).toBeNull();
  });
});
