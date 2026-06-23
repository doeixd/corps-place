import { describe, it, expect } from 'vite-plus/test';
import { chooseAutoPick, type RankedOption, type QueueEntry } from './auto-pick';
import type { CaptionKey } from './captions';

/** isLegal from a set of allowed "corps|caption" keys. */
const legalFrom = (allowed: string[]) => (o: { corpsKey: string; caption: CaptionKey }) =>
  allowed.includes(`${o.corpsKey}|${o.caption}`);

const ranked = (...rows: Array<[string, CaptionKey, number]>): RankedOption[] =>
  rows.map(([corpsKey, caption, score]) => ({ corpsKey, caption, score }));

describe('chooseAutoPick — layer 1: the member queue', () => {
  it('takes the first legal queue entry (explicit caption)', () => {
    const queue: QueueEntry[] = [{ corpsKey: 'c1', caption: 'GE1' }];
    const pick = chooseAutoPick({
      queue,
      ranked: ranked(['c9', 'MP', 100]),
      neededCaptions: new Set(),
      isLegal: legalFrom(['c1|GE1', 'c9|MP']),
    });
    expect(pick).toEqual({ corpsKey: 'c1', caption: 'GE1' });
  });

  it('skips an illegal queue entry and uses the next', () => {
    const queue: QueueEntry[] = [
      { corpsKey: 'c1', caption: 'GE1' },
      { corpsKey: 'c2', caption: 'VP' },
    ];
    const pick = chooseAutoPick({
      queue,
      ranked: [],
      neededCaptions: new Set(),
      isLegal: legalFrom(['c2|VP']), // c1|GE1 already taken
    });
    expect(pick).toEqual({ corpsKey: 'c2', caption: 'VP' });
  });

  it('expands a null-caption entry, preferring a still-needed caption', () => {
    const queue: QueueEntry[] = [{ corpsKey: 'c1', caption: null }];
    const pick = chooseAutoPick({
      queue,
      ranked: [],
      neededCaptions: new Set<CaptionKey>(['VP']),
      isLegal: legalFrom(['c1|GE1', 'c1|VP']), // both legal; VP is needed
    });
    expect(pick).toEqual({ corpsKey: 'c1', caption: 'VP' });
  });

  it('expands a null-caption entry to the first legal caption when nothing is needed', () => {
    const pick = chooseAutoPick({
      queue: [{ corpsKey: 'c1', caption: null }],
      ranked: [],
      neededCaptions: new Set(),
      isLegal: legalFrom(['c1|VP', 'c1|MB']), // GE1/GE2 illegal → first legal in CAPTION_KEYS order is VP
    });
    expect(pick).toEqual({ corpsKey: 'c1', caption: 'VP' });
  });
});

describe('chooseAutoPick — layer 2: roster need', () => {
  it('prefers the best-ranked legal option for a caption still owed, over a higher score', () => {
    const pick = chooseAutoPick({
      queue: [],
      ranked: ranked(['c1', 'GE1', 9], ['c2', 'VP', 8], ['c3', 'VP', 7]),
      neededCaptions: new Set<CaptionKey>(['VP']), // GE1 not needed
      isLegal: legalFrom(['c1|GE1', 'c2|VP', 'c3|VP']),
    });
    expect(pick).toEqual({ corpsKey: 'c2', caption: 'VP' }); // not c1/GE1 despite higher score
  });
});

describe('chooseAutoPick — layer 3: ranked fallback + exhaustion', () => {
  it('falls back to the best-ranked legal option when no queue and no needs', () => {
    const pick = chooseAutoPick({
      queue: [],
      ranked: ranked(['c1', 'GE1', 9], ['c2', 'VP', 8]),
      neededCaptions: new Set(),
      isLegal: legalFrom(['c1|GE1', 'c2|VP']),
    });
    expect(pick).toEqual({ corpsKey: 'c1', caption: 'GE1' });
  });

  it('returns null when nothing is legal anywhere', () => {
    const pick = chooseAutoPick({
      queue: [{ corpsKey: 'c1', caption: 'GE1' }],
      ranked: ranked(['c2', 'VP', 8]),
      neededCaptions: new Set<CaptionKey>(['VP']),
      isLegal: legalFrom([]), // nothing legal
    });
    expect(pick).toBeNull();
  });
});
