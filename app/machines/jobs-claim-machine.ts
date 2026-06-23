import { setup, assign, fromPromise } from 'xstate';
import { suggestClaimMatches, claimPerson, getMyClaims } from '@/lib/server-fns/jobs';

export interface ClaimCandidate {
  entityType: string;
  entityId: string;
  displayName: string;
  photoUrl: string | null;
  description: string;
}

export interface ClaimRow {
  claim_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
}

export interface ClaimContext {
  candidates: ClaimCandidate[];
  claims: ClaimRow[];
  search: string;
  claimingId: string | null;
  error: string | null;
}

export type ClaimEvent =
  | { type: 'SEARCH'; search: string }
  | { type: 'CLAIM'; entityType: string; entityId: string }
  | { type: 'RETRY' };

export interface ClaimInput {
  initialClaims?: ClaimRow[];
  userName?: string;
}

export const jobsClaimMachine = setup({
  types: {
    context: {} as ClaimContext,
    events: {} as ClaimEvent,
    input: {} as ClaimInput,
  },
  actors: {
    fetchSuggestions: fromPromise(async ({ input }: { input: { userName: string } }) => {
      return suggestClaimMatches({ userName: input.userName });
    }),
    searchCandidates: fromPromise(async ({ input }: { input: { search: string } }) => {
      return suggestClaimMatches({ userName: input.search });
    }),
    doClaim: fromPromise(async ({ input }: { input: { entityType: string; entityId: string } }) => {
      return claimPerson(input);
    }),
    fetchClaims: fromPromise(async () => getMyClaims()),
  },
}).createMachine({
  id: 'jobsClaim',
  initial: 'idle',
  context: ({ input }) => ({
    candidates: [],
    claims: input?.initialClaims ?? [],
    search: '',
    claimingId: null,
    error: null,
  }),
  states: {
    idle: {
      on: {
        SEARCH: { target: 'searching', actions: assign({ search: ({ event }) => event.search }) },
        CLAIM: {
          target: 'claiming',
          actions: assign({ claimingId: ({ event }) => `${event.entityType}:${event.entityId}` }),
        },
      },
      ...(({ input }: { input: ClaimInput }) =>
        input?.userName ? { initial: 'suggesting' } : {})(),
    },
    suggesting: {
      invoke: {
        src: 'fetchSuggestions',
        input: ({ context, input }) => ({ userName: input?.userName ?? '' }),
        onDone: {
          target: 'idle',
          actions: assign({ candidates: ({ event }) => event.output }),
        },
        onError: { target: 'idle' },
      },
    },
    searching: {
      invoke: {
        src: 'searchCandidates',
        input: ({ context }) => ({ search: context.search }),
        onDone: {
          target: 'idle',
          actions: assign({ candidates: ({ event }) => event.output, error: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({ error: () => 'Search failed' }),
        },
      },
    },
    claiming: {
      invoke: {
        src: 'doClaim',
        input: ({ context }) => ({
          entityType: context.claimingId?.split(':')[0] ?? '',
          entityId: context.claimingId?.split(':')[1] ?? '',
        }),
        onDone: {
          target: 'refreshing',
          actions: assign({ claimingId: () => null, error: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            claimingId: () => null,
            error: ({ event }) => (event.error as Error)?.message ?? 'Claim failed',
          }),
        },
      },
    },
    refreshing: {
      invoke: {
        src: 'fetchClaims',
        onDone: {
          target: 'idle',
          actions: assign({ claims: ({ event }) => event.output }),
        },
        onError: { target: 'idle' },
      },
    },
  },
});
