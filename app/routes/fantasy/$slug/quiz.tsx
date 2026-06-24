import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { LeagueTabs } from '@/components/fantasy/league-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getLeague, getQuizForLeague } from '@/lib/server-fns/fantasy';
import { Countdown } from '@/components/fantasy/countdown';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Explain } from '@/components/fantasy/explain';
import { fantasyQuizMachine } from '@/machines/fantasy-quiz-machine';

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
    // Only fetch the attempt when we KNOW it won't create one (already completed);
    // starting/resuming is an explicit user action in the machine, so a hover-
    // prefetch of this route never spins up a timed attempt.
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
      description: 'Fantasy drum corps knowledge quiz.',
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
  else body = <QuizSession slug={slug} leagueId={leagueId} completedScore={completedScore} />;

  return (
    <PageShell className="flex flex-col gap-4">
      <header className="space-y-3">
        <BackLink to="/fantasy/$slug" params={{ slug }} label="League home" />
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-text-secondary">{leagueName}</p>
          <h1 className="text-2xl font-bold text-text-primary">Knowledge quiz</h1>
        </div>
        <LeagueTabs slug={slug} active="quiz" isMember={isMember} quizEnabled={quizEnabled} />
      </header>
      {body}
    </PageShell>
  );
}

function QuizSession({
  slug,
  leagueId,
  completedScore,
}: {
  slug: string;
  leagueId: string;
  completedScore: number | null;
}) {
  const [state, send] = useMachine(fantasyQuizMachine, { input: { leagueId, completedScore } });
  const { quiz, answers, score, error } = state.context;

  if (state.matches('done')) return <Completed slug={slug} score={score ?? 0} />;
  if (state.matches('unavailable')) {
    return <Notice slug={slug}>No quiz questions are available yet. Check back soon.</Notice>;
  }

  if (state.matches('idle') || state.matches('starting')) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">
            A quick drum corps knowledge quiz. You get one timed attempt, and your score sets your{' '}
            <Explain term="seeding">draft order</Explain> — higher scores pick earlier.
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <BusyButton busy={state.matches('starting')} onClick={() => send({ type: 'START' })}>
            Start quiz
          </BusyButton>
        </CardContent>
      </Card>
    );
  }

  // answering | submitting
  if (!quiz) return null;
  const allAnswered = answers.every((a) => a >= 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {answers.filter((a) => a >= 0).length} of {quiz.questions.length} answered · one attempt
        </p>
        <p className="text-sm">
          Time left: <Countdown endsAt={quiz.endsAt} />
        </p>
      </div>

      {quiz.questions.map((q, qi) => (
        <Card key={q.questionId}>
          <CardContent className="flex flex-col gap-3">
            <p className="font-medium">
              {qi + 1}. {q.prompt}
            </p>
            <ToggleGroup
              variant="outline"
              orientation="vertical"
              className="w-full"
              value={answers[qi] >= 0 ? [String(answers[qi])] : []}
              onValueChange={(v) => {
                const next = v[0];
                if (next != null)
                  send({ type: 'ANSWER', questionIndex: qi, choiceIndex: Number(next) });
              }}
            >
              {q.choices.map((choice, ci) => (
                <ToggleGroupItem key={ci} value={String(ci)} className="justify-start">
                  {choice}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardContent>
        </Card>
      ))}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center gap-3">
        <BusyButton
          busy={state.matches('submitting')}
          disabled={!allAnswered}
          onClick={() => send({ type: 'SUBMIT' })}
        >
          Submit quiz
        </BusyButton>
        {!allAnswered ? (
          <span className="text-sm text-muted-foreground">Answer every question to submit.</span>
        ) : null}
      </div>
    </div>
  );
}

function Completed({ slug, score }: { slug: string; score: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-lg">
          You scored <strong>{Math.round(score * 100)}%</strong> — your{' '}
          <Explain term="seeding">draft order</Explain> is set.
        </p>
        <p className="text-sm text-muted-foreground">
          When the owner starts the draft you&apos;ll pick in score order. We&apos;ll remind you
          before it begins.
        </p>
        <BackToLeague slug={slug} />
      </CardContent>
    </Card>
  );
}

function Notice({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground">{children}</p>
        <BackToLeague slug={slug} />
      </CardContent>
    </Card>
  );
}

function BackToLeague({ slug }: { slug: string }) {
  return (
    <Button variant="outline" render={<Link to="/fantasy/$slug" params={{ slug }} />}>
      Back to league
    </Button>
  );
}
