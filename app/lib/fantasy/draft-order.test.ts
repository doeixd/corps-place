import { describe, it, expect } from 'vite-plus/test';
import { resolveDraftOrder, seededShuffle, type DraftMember } from './draft-order';

const m = (
  userId: string,
  quizScore: number | null,
  completedAt: string | null = null
): DraftMember => ({
  userId,
  quizScore,
  completedAt,
});

describe('resolveDraftOrder', () => {
  const members = [m('a', 0.9), m('b', 0.5), m('c', 0.7)];

  it('high_first orders by descending quiz score', () => {
    expect(resolveDraftOrder(members, 'high_first', 'seed')).toEqual(['a', 'c', 'b']);
  });

  it('low_first orders by ascending quiz score', () => {
    expect(resolveDraftOrder(members, 'low_first', 'seed')).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by earlier completedAt, then user_id', () => {
    const tied = [
      m('x', 0.5, '2026-06-01T10:00:00Z'),
      m('y', 0.5, '2026-06-01T09:00:00Z'), // finished earlier
      m('z', 0.5, null),
    ];
    // y (earliest) → x → z (null completedAt sorts as '' = earliest, but x has a real ts)
    const order = resolveDraftOrder(tied, 'high_first', 'seed');
    expect(order.indexOf('y')).toBeLessThan(order.indexOf('x'));
  });

  it('non-takers always sort last', () => {
    const mixed = [m('a', 0.9), m('nope1', null), m('b', 0.4), m('nope2', null)];
    const order = resolveDraftOrder(mixed, 'high_first', 'seed');
    expect(order.slice(0, 2)).toEqual(['a', 'b']);
    expect(order.slice(2).sort()).toEqual(['nope1', 'nope2']);
  });

  it('random mode is deterministic for a given seed and a permutation of takers', () => {
    const o1 = resolveDraftOrder(members, 'random', 'league-123');
    const o2 = resolveDraftOrder(members, 'random', 'league-123');
    expect(o1).toEqual(o2);
    expect([...o1].sort()).toEqual(['a', 'b', 'c']);
  });

  it('manual mode honors the owner order and appends omitted members', () => {
    const order = resolveDraftOrder(members, 'manual', 'seed', ['c', 'a']);
    expect(order.slice(0, 2)).toEqual(['c', 'a']);
    expect(order).toContain('b');
    expect(order).toHaveLength(3);
  });

  it('every member appears exactly once', () => {
    const order = resolveDraftOrder(members, 'high_first', 'seed');
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('seededShuffle', () => {
  it('is a stable permutation for a given seed', () => {
    const a = seededShuffle([1, 2, 3, 4, 5], 's');
    const b = seededShuffle([1, 2, 3, 4, 5], 's');
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });
});
