import { setup, assign, fromPromise } from 'xstate';
import { adminJobs, type JobRow } from '@/lib/server-fns/admin-jobs';

/**
 * Jobs poller (ADMIN_PAGE_PLAN §5). Seeded from the route loader, then re-polls every
 * 5s so queued→running→success transitions show live. `FETCH` forces an immediate
 * refresh (used right after enqueue/cancel). Mirrors admin-status-machine.
 */
export interface AdminJobsContext {
  jobs: JobRow[];
  error: string | null;
}
export type AdminJobsEvent = { type: 'FETCH' };
export interface AdminJobsInput {
  jobs?: JobRow[];
}

const POLL_MS = 5_000;

export const adminJobsMachine = setup({
  types: {
    context: {} as AdminJobsContext,
    events: {} as AdminJobsEvent,
    input: {} as AdminJobsInput,
  },
  actors: {
    fetchJobs: fromPromise(async () => adminJobs({ data: { limit: 50 } })),
  },
}).createMachine({
  id: 'adminJobs',
  initial: 'idle',
  context: ({ input }) => ({ jobs: input?.jobs ?? [], error: null }),
  states: {
    idle: {
      after: { [POLL_MS]: 'fetching' },
      on: { FETCH: 'fetching' },
    },
    fetching: {
      invoke: {
        src: 'fetchJobs',
        onDone: {
          target: 'idle',
          actions: assign({ jobs: ({ event }) => event.output, error: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Failed to load jobs',
          }),
        },
      },
    },
  },
});
