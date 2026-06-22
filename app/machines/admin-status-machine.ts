import { setup, assign, fromPromise } from 'xstate';
import { adminStatus } from '@/lib/server-fns/admin';

/** Shape of the Overview snapshot (mirrors `adminStatus` in server-fns/admin.ts). */
export type AdminStatus = Awaited<ReturnType<typeof adminStatus>>;

export interface AdminStatusContext {
  status: AdminStatus | null;
  error: string | null;
}

export type AdminStatusEvent = { type: 'FETCH_STATUS' };

export interface AdminStatusInput {
  status?: AdminStatus | null;
}

const POLL_MS = 15_000;

/**
 * Overview status poller (ADMIN_PAGE_PLAN §4). Auto-fetches on start, then re-polls
 * every 15s from `idle` (debounced enough not to load the 2-vCPU box — R6). The
 * component seeds `input.status` from the route loader so the first paint is instant.
 * Clone of the `event-directory-machine` idle/fetching shape.
 */
export const adminStatusMachine = setup({
  types: {
    context: {} as AdminStatusContext,
    events: {} as AdminStatusEvent,
    input: {} as AdminStatusInput,
  },
  actors: {
    fetchStatus: fromPromise(async () => {
      return await adminStatus();
    }),
  },
}).createMachine({
  id: 'adminStatus',
  initial: 'fetching',
  context: ({ input }) => ({
    status: input?.status ?? null,
    error: null,
  }),
  states: {
    idle: {
      after: { [POLL_MS]: 'fetching' },
      on: { FETCH_STATUS: 'fetching' },
    },
    fetching: {
      invoke: {
        src: 'fetchStatus',
        onDone: {
          target: 'idle',
          actions: assign({
            status: ({ event }) => event.output,
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Failed to load admin status',
          }),
        },
      },
    },
  },
});
