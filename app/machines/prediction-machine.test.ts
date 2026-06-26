import { describe, it, expect } from 'vite-plus/test';
import { createActor } from 'xstate';
import { predictionMachine, predictionSearchCodec } from './prediction-machine';
import type { RecapRow } from '@/lib/prediction-scenario';

const rows: RecapRow[] = [
  { corps_key: 'a', corps: 'A', division: 'World', total: 90 },
  { corps_key: 'b', corps: 'B', division: 'Open', total: 80 },
];

/** Start the machine with scored data so all three views are available. */
const start = () => createActor(predictionMachine, { input: { scoredRecap: rows } }).start();

describe('predictionMachine — view', () => {
  it('defaults to scores when scoredRecap exists, prediction otherwise', () => {
    const withScores = createActor(predictionMachine, { input: { scoredRecap: rows } }).start();
    expect(withScores.getSnapshot().context.view).toBe('scores');

    const noScores = createActor(predictionMachine, { input: {} }).start();
    expect(noScores.getSnapshot().context.view).toBe('prediction');
  });

  it('SET_VIEW switches view and preserves shared sort/group/class-filter state', () => {
    const actor = start();
    actor.send({ type: 'SET_GROUP_BY_CLASS', groupByClass: true });
    actor.send({ type: 'SET_CLASS_FILTERS', classFilters: ['World'] });
    actor.send({ type: 'CYCLE_SORT', key: 'total' }); // sorts on the scores view

    const before = actor.getSnapshot().context;
    actor.send({ type: 'SET_VIEW', view: 'diff' });
    const after = actor.getSnapshot().context;

    expect(after.view).toBe('diff');
    expect(after.groupByClass).toBe(true);
    expect(after.classFilters).toEqual(['World']);
    // Shared sort lists are untouched by the switch (and stay mirrored).
    expect(after.sorts).toEqual(before.sorts);
    expect(after.diffSorts).toEqual(before.diffSorts);
    expect(after.diffSorts).toEqual([{ key: 'total', dir: 'desc' }]);
  });

  it('CYCLE_SORT dispatches to the active view list and mirrors onto the other', () => {
    const actor = start();
    // Scores view → writes `sorts`, mirrors to `diffSorts`.
    actor.send({ type: 'CYCLE_SORT', key: 'GE' });
    let ctx = actor.getSnapshot().context;
    expect(ctx.sorts).toEqual([{ key: 'GE', dir: 'desc' }]);
    expect(ctx.diffSorts).toEqual([{ key: 'GE', dir: 'desc' }]);

    // Diff view → writes `diffSorts`, mirrors to `sorts`.
    actor.send({ type: 'SET_VIEW', view: 'diff' });
    actor.send({ type: 'CYCLE_SORT', key: 'Music' });
    ctx = actor.getSnapshot().context;
    expect(ctx.diffSorts.some((s) => s.key === 'Music' && s.dir === 'desc')).toBe(true);
    expect(ctx.sorts.some((s) => s.key === 'Music' && s.dir === 'desc')).toBe(true);
  });
});

describe('predictionSearchCodec — view', () => {
  const base = createActor(predictionMachine, { input: { scoredRecap: rows } }).start().getSnapshot()
    .context;

  it('omits view when it equals the dynamic default (scores with scored data)', () => {
    expect(predictionSearchCodec.encode({ ...base, view: 'scores' }).view).toBeUndefined();
    expect(predictionSearchCodec.encode({ ...base, view: 'diff' }).view).toBe('diff');
  });

  it('omits view when it equals the dynamic default (prediction without scored data)', () => {
    const noScore = { ...base, scoredRecap: null };
    expect(predictionSearchCodec.encode({ ...noScore, view: 'prediction' }).view).toBeUndefined();
    expect(predictionSearchCodec.encode({ ...noScore, view: 'scores' }).view).toBe('scores');
  });

  it('decode reads a valid view and omits it otherwise (dynamic default applies)', () => {
    expect(predictionSearchCodec.decode({ view: 'diff' }).view).toBe('diff');
    expect('view' in predictionSearchCodec.decode({})).toBe(false);
    expect('view' in predictionSearchCodec.decode({ view: 'bogus' as any })).toBe(false);
  });
});
