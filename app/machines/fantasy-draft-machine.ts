import { setup, assign, fromPromise } from 'xstate';
import {
  scheduleDraft,
  startDraft,
  makePick,
  pauseDraft,
  resumeDraft,
} from '@/lib/server-fns/fantasy';
import { matchMessage } from '@/lib/use-async-action';
import type { CaptionKey } from '@/lib/fantasy/captions';

/**
 * Draft-room action machine (AGENTS.md: model async flows as a machine, no
 * `useState` for loading/error). It owns the owner/picker MUTATIONS — schedule,
 * start, pick, pause, resume — each as an invoked actor with onDone/onError. The
 * LIVE snapshot stays in `useDraftStream` (a `useSyncExternalStore`), which the
 * server keeps fresh over SSE; mutations that don't broadcast (schedule) call the
 * injected `onChanged` to invalidate the loader.
 */
export interface FantasyDraftContext {
  leagueId: string;
  error: string | null;
  feasibility: string | null;
  pendingScheduledAt: string | null;
  pendingPick: { corpsKey: string; caption: CaptionKey } | null;
  onChanged: () => void;
}

export type FantasyDraftEvent =
  | { type: 'SCHEDULE'; scheduledAt: string }
  | { type: 'START' }
  | { type: 'PICK'; corpsKey: string; caption: CaptionKey }
  | { type: 'PAUSE' }
  | { type: 'RESUME' };

export interface FantasyDraftInput {
  leagueId: string;
  onChanged: () => void;
}

const PICK_ERRORS = {
  expired: 'The clock ran out.',
  FORBIDDEN: "It's not your turn.",
  'pair-taken': 'Already drafted by someone.',
  'corps-on-roster': 'That corps is already on your roster.',
  'caption-full': "You've filled that caption.",
};

export const fantasyDraftMachine = setup({
  types: {
    context: {} as FantasyDraftContext,
    events: {} as FantasyDraftEvent,
    input: {} as FantasyDraftInput,
  },
  actors: {
    schedule: fromPromise(({ input }: { input: { leagueId: string; scheduledAt: string } }) =>
      scheduleDraft({ data: { leagueId: input.leagueId, scheduledAt: input.scheduledAt } })
    ),
    start: fromPromise(({ input }: { input: { leagueId: string } }) =>
      startDraft({ data: { leagueId: input.leagueId } })
    ),
    pick: fromPromise(
      ({ input }: { input: { leagueId: string; corpsKey: string; caption: CaptionKey } }) =>
        makePick({
          data: { leagueId: input.leagueId, corpsKey: input.corpsKey, caption: input.caption },
        })
    ),
    pause: fromPromise(({ input }: { input: { leagueId: string } }) =>
      pauseDraft({ data: { leagueId: input.leagueId } })
    ),
    resume: fromPromise(({ input }: { input: { leagueId: string } }) =>
      resumeDraft({ data: { leagueId: input.leagueId } })
    ),
  },
}).createMachine({
  id: 'fantasyDraft',
  context: ({ input }) => ({
    leagueId: input.leagueId,
    error: null,
    feasibility: null,
    pendingScheduledAt: null,
    pendingPick: null,
    onChanged: input.onChanged,
  }),
  initial: 'ready',
  states: {
    ready: {
      on: {
        SCHEDULE: {
          target: 'scheduling',
          actions: assign({
            pendingScheduledAt: ({ event }) => event.scheduledAt,
            error: () => null,
          }),
        },
        START: {
          target: 'starting',
          actions: assign({ error: () => null, feasibility: () => null }),
        },
        PICK: {
          target: 'picking',
          actions: assign({
            pendingPick: ({ event }) => ({ corpsKey: event.corpsKey, caption: event.caption }),
            error: () => null,
          }),
        },
        PAUSE: { target: 'pausing', actions: assign({ error: () => null }) },
        RESUME: { target: 'resuming', actions: assign({ error: () => null }) },
      },
    },
    scheduling: {
      invoke: {
        src: 'schedule',
        input: ({ context }) => ({
          leagueId: context.leagueId,
          scheduledAt: context.pendingScheduledAt ?? '',
        }),
        onDone: { target: 'ready', actions: ({ context }) => context.onChanged() },
        onError: {
          target: 'ready',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Could not schedule.',
          }),
        },
      },
    },
    starting: {
      invoke: {
        src: 'start',
        input: ({ context }) => ({ leagueId: context.leagueId }),
        onDone: {
          target: 'ready',
          actions: [
            assign({ feasibility: ({ event }) => (event.output.ok ? null : event.output.reason) }),
            ({ context }) => context.onChanged(),
          ],
        },
        onError: {
          target: 'ready',
          actions: assign({
            error: ({ event }) =>
              matchMessage(event.error as Error, {
                'need-two-members': 'You need at least two members to start.',
                'identities-incomplete': 'Every member must name their corps first.',
              }),
          }),
        },
      },
    },
    picking: {
      invoke: {
        src: 'pick',
        input: ({ context }) => ({
          leagueId: context.leagueId,
          corpsKey: context.pendingPick?.corpsKey ?? '',
          caption: (context.pendingPick?.caption ?? 'GE1') as CaptionKey,
        }),
        onDone: { target: 'ready' },
        onError: {
          target: 'ready',
          actions: assign({
            error: ({ event }) => matchMessage(event.error as Error, PICK_ERRORS),
          }),
        },
      },
    },
    pausing: {
      invoke: {
        src: 'pause',
        input: ({ context }) => ({ leagueId: context.leagueId }),
        onDone: { target: 'ready' },
        onError: {
          target: 'ready',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Could not pause.',
          }),
        },
      },
    },
    resuming: {
      invoke: {
        src: 'resume',
        input: ({ context }) => ({ leagueId: context.leagueId }),
        onDone: { target: 'ready' },
        onError: {
          target: 'ready',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Could not resume.',
          }),
        },
      },
    },
  },
});
