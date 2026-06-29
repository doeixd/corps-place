import { describe, expect, it } from 'vitest';
import { mergeProfileOverlay, type ProfileOverlay } from './merge';

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
