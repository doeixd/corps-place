import { setup, assign, fromPromise } from 'xstate';
import { upsertJobsProfile, publishJobsProfile } from '@/lib/server-fns/jobs';

export interface ProfileContext {
  displayName: string;
  headline: string;
  location: string;
  kind: 'employee' | 'employer';
  profileId: string | null;
  slug: string | null;
  status: string;
  error: string | null;
  lastSaved: string | null;
}

export type ProfileEvent =
  | { type: 'SET_DISPLAY_NAME'; value: string }
  | { type: 'SET_HEADLINE'; value: string }
  | { type: 'SET_LOCATION'; value: string }
  | { type: 'SET_KIND'; value: 'employee' | 'employer' }
  | { type: 'SAVE' }
  | { type: 'PUBLISH' };

export interface ProfileInput {
  displayName?: string;
  headline?: string;
  location?: string;
  kind?: 'employee' | 'employer';
  profileId?: string | null;
  slug?: string | null;
  status?: string;
}

export const jobsProfileMachine = setup({
  types: {
    context: {} as ProfileContext,
    events: {} as ProfileEvent,
    input: {} as ProfileInput,
  },
  actors: {
    saveProfile: fromPromise(
      async ({
        input,
      }: {
        input: { kind: string; displayName: string; headline: string; location: string };
      }) => {
        return upsertJobsProfile({ data: input });
      }
    ),
    publishProfile: fromPromise(async ({ input }: { input: { profileId: string } }) => {
      return publishJobsProfile({ data: input });
    }),
  },
}).createMachine({
  id: 'jobsProfile',
  initial: 'idle',
  context: ({ input }) => ({
    displayName: input?.displayName ?? '',
    headline: input?.headline ?? '',
    location: input?.location ?? '',
    kind: input?.kind ?? 'employee',
    profileId: input?.profileId ?? null,
    slug: input?.slug ?? null,
    status: input?.status ?? 'draft',
    error: null,
    lastSaved: null,
  }),
  on: {
    SET_DISPLAY_NAME: { actions: assign({ displayName: ({ event }) => event.value }) },
    SET_HEADLINE: { actions: assign({ headline: ({ event }) => event.value }) },
    SET_LOCATION: { actions: assign({ location: ({ event }) => event.value }) },
    SET_KIND: { actions: assign({ kind: ({ event }) => event.value }) },
  },
  states: {
    idle: {
      on: {
        SAVE: 'saving',
        PUBLISH: { target: 'publishing', guard: ({ context }) => !!context.profileId },
      },
    },
    saving: {
      invoke: {
        src: 'saveProfile',
        input: ({ context }) => ({
          kind: context.kind,
          displayName: context.displayName,
          headline: context.headline,
          location: context.location,
        }),
        onDone: {
          target: 'saved',
          actions: assign({
            profileId: ({ event }) => event.output.profileId,
            error: () => null,
            lastSaved: () => new Date().toISOString(),
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Save failed',
          }),
        },
      },
    },
    saved: {
      after: { 2000: 'idle' },
      on: {
        SAVE: 'saving',
        PUBLISH: { target: 'publishing', guard: ({ context }) => !!context.profileId },
      },
    },
    publishing: {
      invoke: {
        src: 'publishProfile',
        input: ({ context }) => ({ profileId: context.profileId! }),
        onDone: {
          target: 'published',
          actions: assign({ status: () => 'published', error: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Publish failed',
          }),
        },
      },
    },
    published: {
      type: 'final',
    },
  },
});
