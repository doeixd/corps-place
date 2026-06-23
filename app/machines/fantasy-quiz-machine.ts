import { setup, assign, fromPromise } from 'xstate';
import { getQuizForLeague, submitQuiz } from '@/lib/server-fns/fantasy';
import { matchMessage } from '@/lib/use-async-action';

/**
 * Quiz-session machine (AGENTS.md: every system flow is an XState machine; no
 * `useState` for loading/error). Owns the one-attempt lifecycle:
 *   deciding → (done | idle) → starting → (answering | done | unavailable)
 *   answering → submitting → (done | answering+error)
 * The component renders from `state.matches(...)` / `state.context` and `send`s
 * events; each async step is an invoked actor that calls the server-fn.
 */
type Quiz = Awaited<ReturnType<typeof getQuizForLeague>>;
type InProgressQuiz = Extract<Quiz, { state: 'in_progress' }>;

export interface FantasyQuizContext {
  leagueId: string;
  quiz: InProgressQuiz | null;
  answers: number[];
  score: number | null;
  error: string | null;
}

export type FantasyQuizEvent =
  | { type: 'START' }
  | { type: 'ANSWER'; questionIndex: number; choiceIndex: number }
  | { type: 'SUBMIT' };

export interface FantasyQuizInput {
  leagueId: string;
  completedScore: number | null;
}

export const fantasyQuizMachine = setup({
  types: {
    context: {} as FantasyQuizContext,
    events: {} as FantasyQuizEvent,
    input: {} as FantasyQuizInput,
  },
  actors: {
    startQuiz: fromPromise(({ input }: { input: { leagueId: string } }) =>
      getQuizForLeague({ data: { leagueId: input.leagueId } })
    ),
    submitQuiz: fromPromise(({ input }: { input: { leagueId: string; answers: number[] } }) =>
      submitQuiz({ data: { leagueId: input.leagueId, answers: input.answers } })
    ),
  },
}).createMachine({
  id: 'fantasyQuiz',
  context: ({ input }) => ({
    leagueId: input.leagueId,
    quiz: null,
    answers: [],
    score: input.completedScore,
    error: null,
  }),
  initial: 'deciding',
  states: {
    // Already completed (loader passed a score) → straight to the result.
    deciding: {
      always: [
        { guard: ({ context }) => context.score != null, target: 'done' },
        { target: 'idle' },
      ],
    },
    idle: {
      on: { START: 'starting' },
    },
    starting: {
      invoke: {
        src: 'startQuiz',
        input: ({ context }) => ({ leagueId: context.leagueId }),
        onDone: [
          {
            guard: ({ event }) => event.output.state === 'in_progress',
            target: 'answering',
            actions: assign({
              quiz: ({ event }) => event.output as InProgressQuiz,
              answers: ({ event }) => (event.output as InProgressQuiz).questions.map(() => -1),
              error: () => null,
            }),
          },
          {
            guard: ({ event }) => event.output.state === 'done',
            target: 'done',
            actions: assign({
              score: ({ event }) =>
                event.output.state === 'done' ? event.output.weightedScore : null,
            }),
          },
          { target: 'unavailable' },
        ],
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error as Error)?.message ?? 'Could not start the quiz.',
          }),
        },
      },
    },
    answering: {
      on: {
        ANSWER: {
          actions: assign({
            answers: ({ context, event }) =>
              context.answers.map((a, i) => (i === event.questionIndex ? event.choiceIndex : a)),
          }),
        },
        SUBMIT: { target: 'submitting' },
      },
    },
    submitting: {
      invoke: {
        src: 'submitQuiz',
        input: ({ context }) => ({ leagueId: context.leagueId, answers: context.answers }),
        onDone: {
          target: 'done',
          actions: assign({ score: ({ event }) => event.output.weightedScore }),
        },
        onError: {
          target: 'answering',
          actions: assign({
            error: ({ event }) =>
              matchMessage(
                event.error as Error,
                {
                  expired: 'Time is up — this attempt has expired.',
                  'already-done': 'You have already completed this quiz.',
                },
                `Could not submit: ${(event.error as Error).message}`
              ),
          }),
        },
      },
    },
    done: {},
    unavailable: {},
  },
});
