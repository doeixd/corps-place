import { describe, it, expect } from 'vitest';
import { collectScrapedReferences } from '@/components/contrib/references-section';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';

const baseShow = (over: Partial<ShowDetail> = {}): ShowDetail =>
  ({
    showId: 's1',
    corpsKey: 'c1',
    corpsName: 'Test',
    season: '2017',
    title: 'A Show',
    subtitle: null,
    description: null,
    premiereDate: null,
    venue: null,
    tagline: null,
    designerNotes: null,
    sourceUrl: null,
    source: null,
    sourceAuthority: null,
    tags: [],
    repertoire: [],
    designers: [],
    movements: [],
    media: [],
    reviews: [],
    ...over,
  }) as ShowDetail;

describe('collectScrapedReferences', () => {
  it('returns nothing when no source urls are present', () => {
    expect(collectScrapedReferences(baseShow())).toEqual([]);
  });

  it('sorts by authority desc and labels yearbook sources', () => {
    const show = baseShow({
      sourceUrl: 'https://corps.example/show',
      source: 'corps-site',
      sourceAuthority: 40,
      designers: [
        {
          role: 'Brass',
          name: 'X',
          sourceUrl: 'https://dci.org/yearbook/2017',
          source: 'dci-yearbook',
          sourceAuthority: 100,
        },
      ] as ShowDetail['designers'],
    });
    const refs = collectScrapedReferences(show);
    expect(refs.map((r) => r.authority)).toEqual([100, 40]);
    expect(refs[0]).toMatchObject({ yearbook: true, title: '2017 DCI Yearbook' });
    expect(refs[1].yearbook).toBe(false);
  });

  it('dedupes the same url, keeping the higher-authority label', () => {
    const url = 'https://dci.org/x';
    const show = baseShow({
      sourceUrl: url,
      source: 'corps-site',
      sourceAuthority: 40,
      repertoire: [
        {
          workTitle: 'W',
          composer: null,
          arranger: null,
          description: null,
          hyperlink: url,
          relatedCorpsKey: null,
          notes: null,
          source: 'dci-yearbook',
          sourceAuthority: 100,
        },
      ] as ShowDetail['repertoire'],
    });
    const refs = collectScrapedReferences(show);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ authority: 100, yearbook: true });
  });
});
