import { describe, it, expect } from 'vite-plus/test';
import {
  leagueReducer,
  isTerminalLeagueStatus,
  type LeagueStatus,
  type LeagueEvent,
} from './league';

const ALL: LeagueStatus[] = [
  'setup',
  'quiz',
  'scheduled',
  'drafting',
  'active',
  'complete',
  'canceled',
];

describe('leagueReducer — the happy path', () => {
  it('walks setup → quiz → scheduled → drafting → active → complete', () => {
    const steps: Array<[LeagueStatus, LeagueEvent['type'], LeagueStatus]> = [
      ['setup', 'OPEN_QUIZ', 'quiz'],
      ['quiz', 'SCHEDULE_DRAFT', 'scheduled'],
      ['scheduled', 'START_DRAFT', 'drafting'],
      ['drafting', 'COMPLETE_DRAFT', 'active'],
      ['active', 'FINALIZE', 'complete'],
    ];
    for (const [from, type, to] of steps) {
      expect(leagueReducer(from, { type })).toEqual({ ok: true, next: to });
    }
  });

  it('allows the current direct setup → drafting (quiz/scheduled unwired)', () => {
    expect(leagueReducer('setup', { type: 'START_DRAFT' })).toEqual({ ok: true, next: 'drafting' });
  });
});

describe('leagueReducer — CANCEL', () => {
  it('cancels from any non-terminal status', () => {
    for (const s of ['setup', 'quiz', 'scheduled', 'drafting', 'active'] as LeagueStatus[]) {
      expect(leagueReducer(s, { type: 'CANCEL' })).toEqual({ ok: true, next: 'canceled' });
    }
  });

  it('refuses to cancel a terminal league', () => {
    expect(leagueReducer('complete', { type: 'CANCEL' })).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
    expect(leagueReducer('canceled', { type: 'CANCEL' })).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
  });
});

describe('leagueReducer — illegal transitions', () => {
  it('rejects START_DRAFT once past the draft, and FINALIZE before active', () => {
    expect(leagueReducer('active', { type: 'START_DRAFT' }).ok).toBe(false);
    expect(leagueReducer('canceled', { type: 'START_DRAFT' }).ok).toBe(false); // no resurrection
    expect(leagueReducer('drafting', { type: 'FINALIZE' }).ok).toBe(false);
    expect(leagueReducer('complete', { type: 'COMPLETE_DRAFT' }).ok).toBe(false);
  });

  it('terminal statuses accept no event', () => {
    const events: LeagueEvent[] = [
      { type: 'OPEN_QUIZ' },
      { type: 'SCHEDULE_DRAFT' },
      { type: 'START_DRAFT' },
      { type: 'COMPLETE_DRAFT' },
      { type: 'FINALIZE' },
      { type: 'CANCEL' },
    ];
    for (const terminal of ['complete', 'canceled'] as LeagueStatus[]) {
      expect(isTerminalLeagueStatus(terminal)).toBe(true);
      for (const e of events) expect(leagueReducer(terminal, e).ok).toBe(false);
    }
  });

  it('every non-terminal status is non-terminal', () => {
    for (const s of ALL.filter((x) => !isTerminalLeagueStatus(x))) {
      expect(isTerminalLeagueStatus(s)).toBe(false);
    }
  });
});
