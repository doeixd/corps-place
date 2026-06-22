import { useState } from 'react';
import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getLeague, getQuizForLeague, submitQuiz } from '@/lib/server-fns/fantasy';
import { useAsyncAction, matchMessage } from '@/lib/use-async-action';
import { Countdown } from '@/components/fantasy/countdown';

type Quiz = Awaited<ReturnType<typeof getQuizForLeague>>;
type InProgressQuiz = Extract<Quiz, { state: 'in_progress' }>;

export const Route = createFileRoute('/fantasy/$slug/quiz')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => {
    let league;
    try {
      league = await getLeague({ data: { slug: params.slug } });
    } catch (e) {
      if ((e as Error).message.includes('NOT_FOUND')) throw notFound();
      throw e;
    }
    const me = league.members.find((m) => m.user_id === league.viewer.userId);
    const quizEnabled = league.league.config.quiz.enabled;
    // Only fetch the attempt when we KNOW it won't create one — i.e. the member
    // has already completed it (the server's done-branch returns without writing).
    // Starting/resuming is an explicit user action below, so a hover-prefetch of
    // this route never spins up a timed attempt.
    const completedScore =
      me?.quiz_taken && quizEnabled
        ? await getQuizForLeague({ data: { leagueId: league.league.leagueId } }).then((q) =>
            q.state === 'done' ? q.weightedScore : null
          )
        : null;

    return {
      slug: params.slug,
      leagueName: league.league.name,
      leagueId: league.league.leagueId,
      isMember: league.viewer.isMember,
      quizEnabled,
      completedScore,
    };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: loaderData ? `Quiz — ${loaderData.leagueName}` : 'Quiz',
      description: 'Fantasy DCI knowledge quiz.',
      path: '/fantasy',
    }),
  component: QuizRoute,
});

function QuizRoute() {
  const { slug, leagueName, leagueId, isMember, quizEnabled, completedScore } =
    Route.useLoaderData();

  let body: React.ReactNode;
  if (!isMember) body = <Notice slug={slug}>You're not a member of this league.</Notice>;
  else if (!quizEnabled) body = <Notice slug={slug}>The quiz is disabled for this league.</Notice>;
  else if (completedScore != null) body = <Completed slug={slug} score={completedScore} />;
  else body = <QuizSession slug={slug} leagueId={leagueId} />;

  return (
    <PageShell className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Knowledge Quiz — {leagueName}</h1>
      {body}
    </PageShell>
  );
}

/** Start/resume the timed attempt (explicit action — never on prefetch). */
function QuizSession({ slug, leagueId }: { slug: string; leagueId: string }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [score, setScore] = useState<number | null>(null);

  const start = useAsyncAction(async () => {
    setQuiz(await getQuizForLeague({ data: { leagueId } }));
  });
  const submit = useAsyncAction(
    async (answers: number[]) => {
      const res = await submitQuiz({ data: { leagueId, answers } });
      setScore(res.weightedScore);
    },
    (err) =>
      matchMessage(
        err,
        {
          expired: 'Time is up — this attempt has expired.',
          already: 'You have already completed this quiz.',
        },
        `Could not submit: ${err.message}`
      )
  );

  if (score != null) return <Completed slug={slug} score={score} />;

  if (!quiz) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground">
          You get one timed attempt. Your score sets your draft seeding.
        </p>
        {start.error ? <p className="text-sm text-destructive">{start.error}</p> : null}
        <Button onClick={() => start.run()} disabled={start.busy}>
          {start.busy ? 'Loading…' : 'Start quiz'}
        </Button>
      </div>
    );
  }

  switch (quiz.state) {
    case 'in_progress':
      return <QuizForm quiz={quiz} onSubmit={submit.run} busy={submit.busy} error={submit.error} />;
    case 'done':
      return <Completed slug={slug} score={quiz.weightedScore} />;
    case 'unavailable':
      return <Notice slug={slug}>No quiz questions are available yet. Check back soon.</Notice>;
    default:
      return <Notice slug={slug}>The quiz is disabled for this league.</Notice>;
  }
}

function QuizForm({
  quiz,
  onSubmit,
  busy,
  error,
}: {
  quiz: InProgressQuiz;
  onSubmit: (answers: number[]) => void;
  busy: boolean;
  error: string | null;
}) {
  const [answers, setAnswers] = useState<number[]>(() => quiz.questions.map(() => -1));
  const allAnswered = answers.every((a) => a >= 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {quiz.questions.length} questions · one attempt
        </p>
        <p className="text-sm">
          Time left: <Countdown endsAt={quiz.endsAt} />
        </p>
      </div>

      {quiz.questions.map((q, qi) => (
        <fieldset
          key={q.questionId}
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
        >
          <legend className="px-1 font-medium">
            {qi + 1}. {q.prompt}
          </legend>
          {q.choices.map((choice, ci) => (
            <label key={ci} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name={`q-${qi}`}
                checked={answers[qi] === ci}
                onChange={() => setAnswers((prev) => prev.map((a, i) => (i === qi ? ci : a)))}
              />
              {choice}
            </label>
          ))}
        </fieldset>
      ))}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button onClick={() => onSubmit(answers)} disabled={busy || !allAnswered}>
          {busy ? 'Submitting…' : 'Submit quiz'}
        </Button>
        {!allAnswered ? (
          <span className="text-sm text-muted-foreground">Answer every question to submit.</span>
        ) : null}
      </div>
    </div>
  );
}

function Completed({ slug, score }: { slug: string; score: number }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-lg">
        You scored <strong>{Math.round(score * 100)}%</strong>. This sets your draft seeding.
      </p>
      <BackToLeague slug={slug} />
    </div>
  );
}

function Notice({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground">{children}</p>
      <BackToLeague slug={slug} />
    </div>
  );
}

function BackToLeague({ slug }: { slug: string }) {
  return (
    <Button variant="outline" render={<Link to="/fantasy/$slug" params={{ slug }} />}>
      Back to league
    </Button>
  );
}
