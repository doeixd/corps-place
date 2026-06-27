import { setup, assign, fromPromise } from 'xstate';
import { upsertJobsProfile, publishJobsProfile } from '@/lib/server-fns/jobs';

export interface ProfileContext {
  displayName: string;
  headline: string;
  location: string;
  zip: string;
  discipline: string;
  kind: 'employee' | 'employer';
  directoryOptOut: boolean;
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
  | { type: 'SET_ZIP'; value: string }
  | { type: 'SET_DISCIPLINE'; value: string }
  | { type: 'SET_KIND'; value: 'employee' | 'employer' }
  | { type: 'SET_DIRECTORY_OPT_OUT'; value: boolean }
  | { type: 'SAVE' }
  | { type: 'PUBLISH' };

export interface ProfileInput {
  displayName?: string;
  headline?: string;
  location?: string;
  zip?: string;
  discipline?: string;
  kind?: 'employee' | 'employer';
  directoryOptOut?: boolean;
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
        input: {
          kind: string;
          displayName: string;
          headline: string;
          location: string;
          zip: string;
          discipline: string;
          directoryOptOut: boolean;
        };
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
    zip: input?.zip ?? '',
    discipline: input?.discipline ?? '',
    kind: input?.kind ?? 'employee',
    directoryOptOut: input?.directoryOptOut ?? false,
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
    SET_ZIP: { actions: assign({ zip: ({ event }) => event.value }) },
    SET_DISCIPLINE: { actions: assign({ discipline: ({ event }) => event.value }) },
    SET_KIND: { actions: assign({ kind: ({ event }) => event.value }) },
    SET_DIRECTORY_OPT_OUT: { actions: assign({ directoryOptOut: ({ event }) => event.value }) },
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
          zip: context.zip,
          discipline: context.discipline,
          directoryOptOut: context.directoryOptOut,
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
    // NOT a final state: a published profile must stay editable + re-savable
    // (a `type: 'final'` state stops processing the root SET_*/SAVE events,
    // which froze the whole Profile tab after Publish).
    published: {
      on: {
        SAVE: 'saving',
      },
    },
  },
});
