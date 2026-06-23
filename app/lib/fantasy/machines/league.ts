/**
 * League lifecycle as a pure state machine (UI/UX plan §13). Today the
 * `league.status` transitions are implicit side effects spread across services:
 * create → 'setup'; draft start → 'drafting' (DraftService); draft complete →
 * 'active' (DraftService); finals recap → 'complete' (StandingsService); owner
 * cancel / payment refund → 'canceled' (League/PaymentService). No single place
 * owns "what's a legal next status", so a stray path can resurrect a canceled
 * league (e.g. starting its still-'scheduled' draft).
 *
 * This table-driven reducer is that single authority. The 'quiz' / 'scheduled'
 * statuses exist in the schema but aren't wired by any current flow yet; they're
 * modeled here so the graph is whole when they are (START_DRAFT already accepts
 * them). The IO shell maps an illegal transition to a typed LeagueConflict.
 */
export type LeagueStatus =
  | 'setup'
  | 'quiz'
  | 'scheduled'
  | 'drafting'
  | 'active'
  | 'complete'
  | 'canceled';

export type LeagueEvent =
  | { type: 'OPEN_QUIZ' }
  | { type: 'SCHEDULE_DRAFT' }
  | { type: 'START_DRAFT' }
  | { type: 'COMPLETE_DRAFT' }
  | { type: 'FINALIZE' }
  | { type: 'CANCEL' };

export type LeagueTransition =
  | { ok: true; next: LeagueStatus }
  | { ok: false; reason: 'illegal-transition' };

/** The legal transition graph: each event's allowed source states → target state. */
const GRAPH: Record<LeagueEvent['type'], { from: readonly LeagueStatus[]; to: LeagueStatus }> = {
  OPEN_QUIZ: { from: ['setup'], to: 'quiz' },
  SCHEDULE_DRAFT: { from: ['setup', 'quiz'], to: 'scheduled' },
  START_DRAFT: { from: ['setup', 'quiz', 'scheduled'], to: 'drafting' },
  COMPLETE_DRAFT: { from: ['drafting'], to: 'active' },
  FINALIZE: { from: ['active'], to: 'complete' },
  // Cancelable from any non-terminal status ('complete' and 'canceled' are terminal).
  CANCEL: { from: ['setup', 'quiz', 'scheduled', 'drafting', 'active'], to: 'canceled' },
};

/** Pure lifecycle transition. Never throws; returns a typed reason on an illegal move. */
export function leagueReducer(status: LeagueStatus, event: LeagueEvent): LeagueTransition {
  const rule = GRAPH[event.type];
  if (!rule.from.includes(status)) return { ok: false, reason: 'illegal-transition' };
  return { ok: true, next: rule.to };
}

/** Whether a status is terminal (no further transitions). */
export const isTerminalLeagueStatus = (status: LeagueStatus): boolean =>
  status === 'complete' || status === 'canceled';
