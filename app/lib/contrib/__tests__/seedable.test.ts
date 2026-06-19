import { describe, it, expect } from 'vitest';
import {
  mergeRepertoire,
  mergeDesigners,
  mergeMovements,
  mergeMedia,
  repertoireNaturalKey,
  designerNaturalKey,
  movementNaturalKey,
  sourceHash,
} from '@/lib/contrib/seedable';
import type { OverrideRow } from '@/lib/contrib/store';
import type {
  ShowDetailDesigner,
  ShowDetailMovement,
  ShowDetailRepertoire,
} from '@sdk/src/readModel/builders/shows.js';

const rep = (workTitle: string, extra: Partial<ShowDetailRepertoire> = {}): ShowDetailRepertoire => ({
  workTitle,
  composer: null,
  arranger: null,
  description: null,
  hyperlink: null,
  relatedCorpsKey: null,
  notes: null,
  source: null,
  sourceAuthority: null,
  ...extra,
});

const designer = (role: string, name: string): ShowDetailDesigner => ({
  role,
  name,
  sourceUrl: null,
  source: null,
  sourceAuthority: null,
});

const movement = (ordinal: number, title: string): ShowDetailMovement => ({
  ordinal,
  title,
  description: null,
  sourceUrl: null,
  source: null,
  sourceAuthority: null,
});

// Minimal OverrideRow factory — only the fields the merge functions read.
const override = (o: Partial<OverrideRow> & Pick<OverrideRow, 'pinned_key' | 'natural_key' | 'state'>): OverrideRow => ({
  override_id: o.override_id ?? `ov-${o.natural_key}`,
  pinned_key: o.pinned_key,
  natural_key: o.natural_key,
  state: o.state,
  content_json: o.content_json ?? null,
  source_hash: o.source_hash ?? null,
  scrape_diverged: o.scrape_diverged ?? 0,
  position: o.position ?? null,
  updated_at: o.updated_at ?? '2026-01-01T00:00:00.000Z',
  updated_by: o.updated_by ?? 'tester',
});

describe('mergeRepertoire', () => {
  it('passes scraped rows through untouched when there are no overrides', () => {
    const scraped = [rep('Bolero', { composer: 'Ravel' }), rep('Firebird')];
    const merged = mergeRepertoire(scraped, []);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ workTitle: 'Bolero', composer: 'Ravel', overridden: false, added: false });
    expect(merged[0].naturalKey).toBe(repertoireNaturalKey(scraped[0], 0));
    expect(merged[0].sourceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('lets an edited override win over the scraped value (displayed = override ?? scraped)', () => {
    const scraped = [rep('Bolero', { composer: 'Ravel' })];
    const key = repertoireNaturalKey(scraped[0], 0);
    const merged = mergeRepertoire(scraped, [
      override({
        pinned_key: 'repertoire',
        natural_key: key,
        state: 'edited',
        content_json: JSON.stringify({ workTitle: 'Boléro', composer: 'Maurice Ravel' }),
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ workTitle: 'Boléro', composer: 'Maurice Ravel', overridden: true });
  });

  it('hides a scraped row when a tombstone (hidden) override exists', () => {
    const scraped = [rep('Bolero'), rep('Firebird')];
    const merged = mergeRepertoire(scraped, [
      override({ pinned_key: 'repertoire', natural_key: repertoireNaturalKey(scraped[0], 0), state: 'hidden' }),
    ]);
    expect(merged.map((m) => m.workTitle)).toEqual(['Firebird']);
  });

  it('appends added rows that have no scraped counterpart', () => {
    const scraped = [rep('Bolero')];
    const merged = mergeRepertoire(scraped, [
      override({
        pinned_key: 'repertoire',
        natural_key: 'new-piece#1',
        state: 'added',
        content_json: JSON.stringify({ workTitle: 'Encore' }),
      }),
    ]);
    expect(merged).toHaveLength(2);
    const added = merged.find((m) => m.added);
    expect(added).toMatchObject({ workTitle: 'Encore', added: true, overridden: true });
  });

  it('surfaces scrape_diverged from the override row', () => {
    const scraped = [rep('Bolero')];
    const key = repertoireNaturalKey(scraped[0], 0);
    const merged = mergeRepertoire(scraped, [
      override({
        pinned_key: 'repertoire',
        natural_key: key,
        state: 'edited',
        content_json: JSON.stringify({ workTitle: 'Bolero' }),
        scrape_diverged: 1,
      }),
    ]);
    expect(merged[0].scrapeDiverged).toBe(true);
  });

  it('keeps an override attached when the scraper reorders distinct works (reorder-safe key)', () => {
    const bolero = rep('Bolero');
    const firebird = rep('Firebird');
    // Override authored against Firebird while it was second in the list.
    const key = repertoireNaturalKey(firebird, 0); // first (only) occurrence of "Firebird"
    const ov = override({
      pinned_key: 'repertoire',
      natural_key: key,
      state: 'edited',
      content_json: JSON.stringify({ workTitle: 'The Firebird Suite' }),
    });
    // Scraper later reorders: Firebird now comes first.
    const merged = mergeRepertoire([firebird, bolero], [ov]);
    const edited = merged.find((m) => m.workTitle === 'The Firebird Suite');
    expect(edited).toBeDefined();
    expect(edited?.overridden).toBe(true);
    // And the untouched row is still plain.
    expect(merged.find((m) => m.workTitle === 'Bolero')?.overridden).toBe(false);
  });

  it('distinguishes duplicate titles by occurrence', () => {
    const scraped = [rep('Bolero'), rep('Bolero')];
    const keys = mergeRepertoire(scraped, []).map((m) => m.naturalKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([repertoireNaturalKey(scraped[0], 0), repertoireNaturalKey(scraped[1], 1)]);
  });

  it('ignores overrides for other pinned keys', () => {
    const scraped = [rep('Bolero')];
    const merged = mergeRepertoire(scraped, [
      override({ pinned_key: 'designers', natural_key: 'whatever', state: 'hidden' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].overridden).toBe(false);
  });
});

describe('mergeDesigners', () => {
  it('keys on role+name so it is stable regardless of array order', () => {
    const scraped = [designer('Brass Arranger', 'Key Poulan'), designer('Visual', 'Jane Doe')];
    const key = designerNaturalKey(scraped[0]);
    const merged = mergeDesigners([scraped[1], scraped[0]], [
      override({
        pinned_key: 'designers',
        natural_key: key,
        state: 'edited',
        content_json: JSON.stringify({ role: 'Brass Arranger', name: 'Key Poulan Jr.' }),
      }),
    ]);
    const edited = merged.find((m) => m.role === 'Brass Arranger');
    expect(edited).toMatchObject({ name: 'Key Poulan Jr.', overridden: true });
  });
});

describe('mergeMovements', () => {
  it('returns movements sorted by ordinal and keys on ordinal', () => {
    const scraped = [movement(2, 'II'), movement(1, 'I')];
    const merged = mergeMovements(scraped, [
      override({
        pinned_key: 'movements',
        natural_key: movementNaturalKey(scraped[1]),
        state: 'edited',
        content_json: JSON.stringify({ ordinal: 1, title: 'Opening' }),
      }),
    ]);
    expect(merged.map((m) => m.ordinal)).toEqual([1, 2]);
    expect(merged[0].title).toBe('Opening');
  });
});

describe('mergeMedia', () => {
  it('keys on the url hash so reordered media keep their overrides', () => {
    const a = { mediaType: 'video', title: 'A', description: null, url: 'https://x/a', thumbnailUrl: null, attribution: null, source: null, sourceAuthority: null, publishedAt: null, durationSeconds: null };
    const b = { ...a, title: 'B', url: 'https://x/b' };
    const merged = mergeMedia([b, a], []);
    expect(merged).toHaveLength(2);
    expect(merged.every((m) => !m.overridden)).toBe(true);
  });
});
