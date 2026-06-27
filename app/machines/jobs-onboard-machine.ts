import { setup, assign, fromPromise } from 'xstate';
import { upsertJobsProfile, saveJobsProfileBlock, publishJobsProfile } from '@/lib/server-fns/jobs';

export interface OnboardContext {
  // Step 1: About
  kind: 'employee' | 'employer';
  displayName: string;
  headline: string;
  location: string;
  zip: string;
  // Step 2: Experience
  experience: Array<{
    org: string;
    role: string;
    startYear: string;
    endYear: string;
    description: string;
  }>;
  // Step 3: Skills
  skills: string[];
  // Step 4: Availability
  fullTime: boolean;
  partTime: boolean;
  seasonal: boolean;
  seasonalPeriod: string;
  willingToRelocate: boolean;
  remoteOnly: boolean;
  // Step 5: Review
  profileId: string | null;
  error: string | null;
}

export type OnboardEvent =
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SET_KIND'; value: 'employee' | 'employer' }
  | { type: 'SET_DISPLAY_NAME'; value: string }
  | { type: 'SET_HEADLINE'; value: string }
  | { type: 'SET_LOCATION'; value: string }
  | { type: 'SET_ZIP'; value: string }
  | { type: 'ADD_EXPERIENCE'; item: OnboardContext['experience'][0] }
  | { type: 'REMOVE_EXPERIENCE'; index: number }
  | { type: 'ADD_SKILL'; value: string }
  | { type: 'REMOVE_SKILL'; index: number }
  | { type: 'SET_FULL_TIME'; value: boolean }
  | { type: 'SET_PART_TIME'; value: boolean }
  | { type: 'SET_SEASONAL'; value: boolean }
  | { type: 'SET_SEASONAL_PERIOD'; value: string }
  | { type: 'SET_RELOCATE'; value: boolean }
  | { type: 'SET_REMOTE'; value: boolean }
  | { type: 'PUBLISH' };

export const jobsOnboardMachine = setup({
  types: {
    context: {} as OnboardContext,
    events: {} as OnboardEvent,
  },
  actors: {
    saveStep1: fromPromise(
      async ({
        input,
      }: {
        input: {
          kind: string;
          displayName: string;
          headline: string;
          location: string;
          zip: string;
        };
      }) => {
        return upsertJobsProfile({ data: input });
      }
    ),
    saveStep2: fromPromise(
      async ({ input }: { input: { profileId: string; items: OnboardContext['experience'] } }) => {
        await saveJobsProfileBlock({
          data: {
            profileId: input.profileId,
            kind: 'experience',
            content: { items: input.items },
          },
        });
      }
    ),
    saveStep3: fromPromise(async ({ input }: { input: { profileId: string; items: string[] } }) => {
      await saveJobsProfileBlock({
        data: {
          profileId: input.profileId,
          kind: 'skills',
          content: { items: input.items },
        },
      });
    }),
    saveStep4: fromPromise(
      async ({
        input,
      }: {
        input: { profileId: string; availability: Record<string, unknown> };
      }) => {
        await saveJobsProfileBlock({
          data: {
            profileId: input.profileId,
            kind: 'availability',
            content: input.availability,
          },
        });
      }
    ),
    publish: fromPromise(async ({ input }: { input: { profileId: string } }) => {
      return publishJobsProfile({ data: input });
    }),
  },
}).createMachine({
  id: 'jobsOnboard',
  initial: 'about',
  context: {
    kind: 'employee',
    displayName: '',
    headline: '',
    location: '',
    zip: '',
    experience: [],
    skills: [],
    fullTime: false,
    partTime: false,
    seasonal: false,
    seasonalPeriod: '',
    willingToRelocate: false,
    remoteOnly: false,
    profileId: null,
    error: null,
  },
  states: {
    about: {
      on: {
        NEXT: {
          target: 'savingStep1',
          guard: ({ context }) => context.displayName.trim().length > 0,
        },
        SET_KIND: { actions: assign({ kind: ({ event }) => event.value }) },
        SET_DISPLAY_NAME: { actions: assign({ displayName: ({ event }) => event.value }) },
        SET_HEADLINE: { actions: assign({ headline: ({ event }) => event.value }) },
        SET_LOCATION: { actions: assign({ location: ({ event }) => event.value }) },
        SET_ZIP: { actions: assign({ zip: ({ event }) => event.value }) },
      },
    },
    savingStep1: {
      invoke: {
        src: 'saveStep1',
        input: ({ context }) => ({
          kind: context.kind,
          displayName: context.displayName,
          headline: context.headline,
          location: context.location,
          zip: context.zip,
        }),
        onDone: {
          target: 'experience',
          actions: assign({ profileId: ({ event }) => event.output.profileId, error: () => null }),
        },
        onError: {
          target: 'about',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Save failed',
          }),
        },
      },
    },
    experience: {
      on: {
        NEXT: 'savingStep2',
        BACK: 'about',
        ADD_EXPERIENCE: {
          actions: assign({
            experience: ({ context, event }) => [...context.experience, event.item],
          }),
        },
        REMOVE_EXPERIENCE: {
          actions: assign({
            experience: ({ context, event }) =>
              context.experience.filter((_, i) => i !== event.index),
          }),
        },
      },
    },
    savingStep2: {
      invoke: {
        src: 'saveStep2',
        input: ({ context }) => ({ profileId: context.profileId!, items: context.experience }),
        onDone: { target: 'skills', actions: assign({ error: () => null }) },
        onError: {
          target: 'experience',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Save failed',
          }),
        },
      },
    },
    skills: {
      on: {
        NEXT: 'savingStep3',
        BACK: 'experience',
        ADD_SKILL: {
          actions: assign({ skills: ({ context, event }) => [...context.skills, event.value] }),
        },
        REMOVE_SKILL: {
          actions: assign({
            skills: ({ context, event }) => context.skills.filter((_, i) => i !== event.index),
          }),
        },
      },
    },
    savingStep3: {
      invoke: {
        src: 'saveStep3',
        input: ({ context }) => ({ profileId: context.profileId!, items: context.skills }),
        onDone: { target: 'availability', actions: assign({ error: () => null }) },
        onError: {
          target: 'skills',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Save failed',
          }),
        },
      },
    },
    availability: {
      on: {
        NEXT: 'savingStep4',
        BACK: 'skills',
        SET_FULL_TIME: { actions: assign({ fullTime: ({ event }) => event.value }) },
        SET_PART_TIME: { actions: assign({ partTime: ({ event }) => event.value }) },
        SET_SEASONAL: { actions: assign({ seasonal: ({ event }) => event.value }) },
        SET_SEASONAL_PERIOD: { actions: assign({ seasonalPeriod: ({ event }) => event.value }) },
        SET_RELOCATE: { actions: assign({ willingToRelocate: ({ event }) => event.value }) },
        SET_REMOTE: { actions: assign({ remoteOnly: ({ event }) => event.value }) },
      },
    },
    savingStep4: {
      invoke: {
        src: 'saveStep4',
        input: ({ context }) => ({
          profileId: context.profileId!,
          availability: {
            fullTime: context.fullTime,
            partTime: context.partTime,
            seasonal: context.seasonal,
            seasonalPeriod: context.seasonalPeriod,
            willingToRelocate: context.willingToRelocate,
            remoteOnly: context.remoteOnly,
          },
        }),
        onDone: { target: 'review', actions: assign({ error: () => null }) },
        onError: {
          target: 'availability',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Save failed',
          }),
        },
      },
    },
    review: {
      on: {
        PUBLISH: 'publishing',
        BACK: 'availability',
      },
    },
    publishing: {
      invoke: {
        src: 'publish',
        input: ({ context }) => ({ profileId: context.profileId! }),
        onDone: { target: 'done', actions: assign({ error: () => null }) },
        onError: {
          target: 'review',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Publish failed',
          }),
        },
      },
    },
    done: { type: 'final' },
  },
});
