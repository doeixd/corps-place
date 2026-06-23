import { describe, it, expect } from 'vite-plus/test';
import {
  draftReducer,
  currentUserId,
  currentRound,
  type DraftMachineState,
  type DraftEvent,
} from './draft';

const scheduled: DraftMachineState = {
  status: 'scheduled',
  draftType: 'snake',
  order: [],
  totalRounds: 2,
  currentPickNo: 0,
};

const live = (over: Partial<DraftMachineState> = {}): DraftMachineState => ({
  status: 'live',
  draftType: 'snake',
  order: ['A', 'B'],
  totalRounds: 2,
  currentPickNo: 0,
  ...over,
});

/** Assert a transition succeeded and return the next state. */
const next = (s: DraftMachineState, e: DraftEvent): DraftMachineState => {
  const r = draftReducer(s, e);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.next;
};

describe('draftReducer — START', () => {
  it('scheduled → live with order, pick 0, first drafter on the clock', () => {
    const s = next(scheduled, {
      type: 'START',
      order: ['A', 'B'],
      totalRounds: 2,
      draftType: 'snake',
    });
    expect(s.status).toBe('live');
    expect(s.currentPickNo).toBe(0);
    expect(currentUserId(s)).toBe('A');
    expect(currentRound(s)).toBe(1);
  });

  it('rejects START unless scheduled', () => {
    const r = draftReducer(live(), {
      type: 'START',
      order: ['A', 'B'],
      totalRounds: 2,
      draftType: 'snake',
    });
    expect(r).toEqual({ ok: false, reason: 'already-started' });
  });

  it('rejects START with fewer than 2 drafters', () => {
    const r = draftReducer(scheduled, {
      type: 'START',
      order: ['A'],
      totalRounds: 2,
      draftType: 'snake',
    });
    expect(r).toEqual({ ok: false, reason: 'empty-order' });
  });
});

describe('draftReducer — PICK (snake order + completion)', () => {
  it('runs a full 2×2 snake draft A,B,B,A then completes', () => {
    let s = live();
    expect(currentUserId(s)).toBe('A');
    s = next(s, { type: 'PICK', userId: 'A' });
    expect(currentUserId(s)).toBe('B'); // round 1 pos 1
    s = next(s, { type: 'PICK', userId: 'B' });
    expect(currentUserId(s)).toBe('B'); // round 2 reverses
    expect(currentRound(s)).toBe(2);
    s = next(s, { type: 'PICK', userId: 'B' });
    expect(currentUserId(s)).toBe('A');
    s = next(s, { type: 'PICK', userId: 'A' });
    expect(s.status).toBe('complete');
    expect(s.currentPickNo).toBe(4);
    expect(currentUserId(s)).toBeNull();
    expect(currentRound(s)).toBe(0);
  });

  it('rejects a pick out of turn', () => {
    const r = draftReducer(live(), { type: 'PICK', userId: 'B' }); // A is on the clock
    expect(r).toEqual({ ok: false, reason: 'out-of-turn' });
  });

  it('rejects a pick when not live', () => {
    expect(draftReducer(scheduled, { type: 'PICK', userId: 'A' })).toEqual({
      ok: false,
      reason: 'not-live',
    });
    expect(draftReducer(live({ status: 'paused' }), { type: 'PICK', userId: 'A' })).toEqual({
      ok: false,
      reason: 'not-live',
    });
  });
});

describe('draftReducer — PAUSE / RESUME', () => {
  it('pauses a live draft and resumes it', () => {
    const paused = next(live(), { type: 'PAUSE' });
    expect(paused.status).toBe('paused');
    expect(currentUserId(paused)).toBeNull(); // no clock while paused
    const resumed = next(paused, { type: 'RESUME' });
    expect(resumed.status).toBe('live');
    expect(resumed.currentPickNo).toBe(paused.currentPickNo); // position preserved
    expect(currentUserId(resumed)).toBe('A');
  });

  it('rejects PAUSE when not live and RESUME when not paused', () => {
    expect(draftReducer(scheduled, { type: 'PAUSE' })).toEqual({ ok: false, reason: 'not-live' });
    expect(draftReducer(live(), { type: 'RESUME' })).toEqual({ ok: false, reason: 'not-paused' });
  });
});

describe('draftReducer — derived helpers across states', () => {
  it('currentUserId/currentRound are null/0 unless live and unfinished', () => {
    expect(currentUserId(scheduled)).toBeNull();
    expect(currentRound(scheduled)).toBe(0);
    expect(currentUserId(live({ status: 'complete', currentPickNo: 4 }))).toBeNull();
  });
});
