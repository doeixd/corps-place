import { setup, assign, fromPromise } from 'xstate';
import {
  getHybridEventDirectory,
  getHybridRefreshStatus,
  startHybridRefresh,
} from '@/lib/server-fns/hybrid';
import * as EventPredicates from '@/predicates/event';

export interface EventDirectoryContext {
  events: any[];
  refreshStatus: any | null;
  error: string | null;
}

export type EventDirectoryEvent =
  | { type: 'FETCH_EVENTS' }
  | { type: 'FETCH_REFRESH_STATUS' }
  | { type: 'START_REFRESH' }
  | { type: 'RESET' };

export interface EventDirectoryInput {
  events?: any[];
  refreshStatus?: any | null;
}

export const eventDirectoryMachine = setup({
  types: {
    context: {} as EventDirectoryContext,
    events: {} as EventDirectoryEvent,
    input: {} as EventDirectoryInput,
  },
  actors: {
    fetchEvents: fromPromise(async () => {
      return await getHybridEventDirectory();
    }),
    fetchRefreshStatus: fromPromise(async () => {
      return await getHybridRefreshStatus();
    }),
    startRefresh: fromPromise(async () => {
      return await startHybridRefresh();
    }),
  },
}).createMachine({
  id: 'eventDirectory',
  initial: 'idle',
  context: ({ input }) => ({
    events: input?.events ?? [],
    refreshStatus: input?.refreshStatus ?? null,
    error: null,
  }),
  states: {
    idle: {
      on: {
        FETCH_EVENTS: 'fetchingEvents',
        FETCH_REFRESH_STATUS: 'fetchingRefreshStatus',
        START_REFRESH: {
          guard: ({ context }) => EventPredicates.canStartRefresh(context),
          target: 'startingRefresh',
        },
        RESET: {
          actions: assign({ error: () => null }),
        },
      },
    },
    fetchingEvents: {
      invoke: {
        src: 'fetchEvents',
        onDone: {
          target: 'idle',
          actions: assign({
            events: ({ event }) => event.output ?? [],
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as any)?.message ?? 'Failed to load events',
          }),
        },
      },
    },
    fetchingRefreshStatus: {
      invoke: {
        src: 'fetchRefreshStatus',
        onDone: {
          target: 'idle',
          actions: assign({
            refreshStatus: ({ event }) => event.output ?? null,
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as any)?.message ?? 'Failed to load refresh status',
          }),
        },
      },
    },
    startingRefresh: {
      invoke: {
        src: 'startRefresh',
        onDone: {
          target: 'idle',
          actions: assign({
            refreshStatus: ({ event }) => event.output ?? null,
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as any)?.message ?? 'Failed to start refresh',
          }),
        },
      },
    },
  },
});
