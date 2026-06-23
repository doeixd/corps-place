/**
 * Draft lifecycle as a pure state machine (UI/UX plan §13). Models the status
 * transitions — scheduled → live ↔ paused → complete — that DraftService
 * currently hand-rolls across start / makePick / pause / resume / complete with
 * scattered status checks. No I/O: given a state + event it returns the next
 * state or a typed illegal-transition reason, so every state×event is
 * exhaustively unit-testable and an illegal move is impossible by construction.
 *
 * The IO shell (DraftService) loads the row, calls `draftReducer`, persists
 * `next`, and runs the side effects (SQL, PubSub, timers, notifications). The
 * *who-picks-when* / weight / legality math stays in `../draft`; this only owns
 * the lifecycle. Reducer errors map at the boundary: `out-of-turn` → Forbidden,
 * everything else → DraftConflict(reason).
 */
import { type DraftType, userAt, roundIndexOf, isDraftComplete } from '../draft';

export type DraftStatus = 'scheduled' | 'live' | 'paused' | 'complete';

export interface DraftMachineState {
  status: DraftStatus;
  draftType: DraftType;
  /** Draft order (user ids); empty until START. */
  order: readonly string[];
  totalRounds: number;
  /** 0-based global pick index. */
  currentPickNo: number;
}

export type DraftEvent =
  | { type: 'START'; order: readonly string[]; totalRounds: number; draftType: DraftType }
  | { type: 'PICK'; userId: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' };

export type DraftReducerError =
  | 'already-started' // START when not 'scheduled'
  | 'empty-order' // START with fewer than 2 drafters
  | 'not-live' // PICK / PAUSE when not 'live'
  | 'not-paused' // RESUME when not 'paused'
  | 'out-of-turn' // PICK by a member who isn't on the clock
  | 'already-complete'; // PICK with no one left on the clock

export type DraftTransition =
  | { ok: true; next: DraftMachineState }
  | { ok: false; reason: DraftReducerError };

const ok = (next: DraftMachineState): DraftTransition => ({ ok: true, next });
const fail = (reason: DraftReducerError): DraftTransition => ({ ok: false, reason });

/** The user_id on the clock, or null if the draft isn't live / is finished. */
export function currentUserId(state: DraftMachineState): string | null {
  if (state.status !== 'live' || state.order.length === 0) return null;
  if (isDraftComplete(state.currentPickNo, state.order.length, state.totalRounds)) return null;
  return userAt(state.order, state.currentPickNo, state.draftType);
}

/** 1-based current round (0 when not live / finished). */
export function currentRound(state: DraftMachineState): number {
  if (state.status !== 'live' || state.order.length === 0) return 0;
  if (isDraftComplete(state.currentPickNo, state.order.length, state.totalRounds)) return 0;
  return roundIndexOf(state.currentPickNo, state.order.length) + 1;
}

/** Pure lifecycle transition. Never throws; returns a typed reason on an illegal move. */
export function draftReducer(state: DraftMachineState, event: DraftEvent): DraftTransition {
  switch (event.type) {
    case 'START': {
      if (state.status !== 'scheduled') return fail('already-started');
      if (event.order.length < 2) return fail('empty-order');
      return ok({
        status: 'live',
        draftType: event.draftType,
        order: event.order,
        totalRounds: event.totalRounds,
        currentPickNo: 0,
      });
    }
    case 'PICK': {
      if (state.status !== 'live') return fail('not-live');
      const onClock = currentUserId(state);
      if (onClock === null) return fail('already-complete');
      if (event.userId !== onClock) return fail('out-of-turn');
      const nextPickNo = state.currentPickNo + 1;
      const complete = isDraftComplete(nextPickNo, state.order.length, state.totalRounds);
      return ok({ ...state, currentPickNo: nextPickNo, status: complete ? 'complete' : 'live' });
    }
    case 'PAUSE': {
      if (state.status !== 'live') return fail('not-live');
      return ok({ ...state, status: 'paused' });
    }
    case 'RESUME': {
      if (state.status !== 'paused') return fail('not-paused');
      return ok({ ...state, status: 'live' });
    }
  }
}
