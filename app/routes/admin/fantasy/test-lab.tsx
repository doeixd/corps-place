// Fantasy Test Lab (docs/plans/FANTASY_TEST_LAB_PLAN.md) — admin-only sandbox to
// exercise quiz → draft → standings in an is_test league driven by bots.
import { useState } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/fantasy/confirm-dialog';
import { seoHead } from '@/lib/seo';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  adminListTestLeagues,
  adminCreateTestLeague,
  adminDeleteTestLeague,
  adminStartDraftNow,
  adminAutoPickCurrent,
  adminFastForwardDraft,
  adminRecomputeStandings,
  adminSeedQuizQuestions,
  adminResetQuizAttempt,
  adminSeedSyntheticScores,
  adminSendTestNotification,
} from '@/lib/server-fns/admin-fantasy';

const NOTIF_KINDS: { kind: string; label: string }[] = [
  { kind: 'draft_scheduled', label: 'Scheduled (email)' },
  { kind: 'draft_live', label: 'Live (email+push)' },
  { kind: 'draft_complete', label: 'Complete (email+push)' },
  { kind: 'on_clock', label: 'On the clock (push)' },
  { kind: 'on_deck', label: 'On deck (push)' },
  { kind: 'standings', label: 'Standings (email)' },
];

type TestLeague = Awaited<ReturnType<typeof adminListTestLeagues>>['leagues'][number];

export const Route = createFileRoute('/admin/fantasy/test-lab')({
  loader: adminLoader('manageFantasyLeagues', () => adminListTestLeagues()),
  head: () =>
    seoHead({ title: 'Admin — Fantasy Test Lab', description: 'Sandbox', path: '/admin/fantasy/test-lab' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <TestLab leagues={data?.leagues ?? []} />}</AdminPage>;
  },
});

function TestLab({ leagues }: { leagues: TestLeague[] }) {
  const router = useRouter();
  const refresh = () => router.invalidate();

  const [name, setName] = useState('Test League');
  const [members, setMembers] = useState('4');
  const [draftType, setDraftType] = useState<'snake' | 'linear'>('snake');
  const [pickSeconds, setPickSeconds] = useState('60');
  const [quizScores, setQuizScores] = useState(true);

  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const seedQuiz = useAsyncAction(async () => {
    const r = await adminSeedQuizQuestions();
    setSeedMsg(`Quiz bank seeded — ${r.added} added (${r.total} sample questions).`);
  });

  const [notifMsg, setNotifMsg] = useState<string | null>(null);
  const sendNotif = useAsyncAction(async (kind: string) => {
    const r = await adminSendTestNotification({ data: { kind } });
    setNotifMsg(
      `Sent — ${r.emailedTo ? `email → ${r.emailedTo}` : 'no email on file'}${r.pushed ? ' + push' : ''}.`
    );
  });

  const create = useAsyncAction(async () => {
    const res = await adminCreateTestLeague({
      data: {
        name,
        members: Number(members) || 4,
        draftType,
        pickSeconds: Number(pickSeconds) || 60,
        withQuizScores: quizScores,
      },
    });
    router.navigate({ to: '/fantasy/$slug', params: { slug: res.slug } });
  });

  return (
    <>
      <PageHeader
        title="Fantasy Test Lab"
        subtitle="Spin up a sandbox league with bots and drive it through quiz, draft, and standings"
        backTo="/admin"
        backLabel="Admin"
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={seedQuiz.busy} onClick={() => void seedQuiz.run()}>
          {seedQuiz.busy ? 'Seeding…' : 'Seed quiz bank'}
        </Button>
        {seedMsg ? <span className="text-sm text-text-secondary">{seedMsg}</span> : null}
        {seedQuiz.error ? <span className="text-sm text-destructive">{seedQuiz.error}</span> : null}
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Create a test league
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="tl-name">Name</Label>
              <Input id="tl-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="tl-members">Members (incl. you, 2–12)</Label>
              <Input
                id="tl-members"
                type="number"
                min={2}
                max={12}
                value={members}
                onChange={(e) => setMembers(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="tl-type">Draft type</Label>
              <select
                id="tl-type"
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={draftType}
                onChange={(e) => setDraftType(e.target.value as 'snake' | 'linear')}
              >
                <option value="snake">Snake</option>
                <option value="linear">Linear</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="tl-secs">Pick timer (seconds)</Label>
              <Input
                id="tl-secs"
                type="number"
                min={10}
                value={pickSeconds}
                onChange={(e) => setPickSeconds(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={quizScores} onCheckedChange={(v) => setQuizScores(!!v)} />
            Pre-fill quiz scores + draft order (skip the quiz to test the draft fast)
          </label>
          {create.error ? <p className="text-sm text-destructive">{create.error}</p> : null}
          <Button className="self-start" disabled={create.busy} onClick={() => void create.run()}>
            {create.busy ? 'Creating…' : 'Create test league'}
          </Button>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Notification preview (sends to you)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {NOTIF_KINDS.map((n) => (
              <Button
                key={n.kind}
                size="sm"
                variant="outline"
                disabled={sendNotif.busy}
                onClick={() => void sendNotif.run(n.kind)}
              >
                {n.label}
              </Button>
            ))}
          </div>
          {notifMsg ? <p className="text-sm text-text-secondary">{notifMsg}</p> : null}
          {sendNotif.error ? <p className="text-sm text-destructive">{sendNotif.error}</p> : null}
        </CardContent>
      </Card>

      <h2 className="mb-2 text-sm font-semibold text-text-secondary">Test leagues</h2>
      {leagues.length === 0 ? (
        <p className="text-sm text-text-secondary">None yet — create one above.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {leagues.map((l) => (
            <TestLeagueRow key={l.leagueId} league={l} onChanged={refresh} />
          ))}
        </ul>
      )}
    </>
  );
}

function TestLeagueRow({ league, onChanged }: { league: TestLeague; onChanged: () => void }) {
  const act = useAsyncAction(async (fn: () => Promise<unknown>) => {
    await fn();
    onChanged();
  });

  return (
    <li>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{league.name}</span>
            <Badge variant="warning-light" size="sm">
              TEST
            </Badge>
            <span className="text-xs text-text-secondary">
              {league.status} · {league.members} members · {league.season}
              {league.draftProgress
                ? ` · draft pick ${league.draftProgress.pickNo}/${league.draftProgress.totalPicks}${
                    league.draftProgress.onClock ? ` · on the clock: ${league.draftProgress.onClock}` : ''
                  }`
                : league.draftStatus
                  ? ` · draft ${league.draftStatus}`
                  : ''}
            </span>
          </div>

          <div className="flex flex-wrap gap-2 text-sm">
            <Link className="underline" to="/fantasy/$slug" params={{ slug: league.slug }}>
              Home
            </Link>
            <Link className="underline" to="/fantasy/$slug/quiz" params={{ slug: league.slug }}>
              Quiz
            </Link>
            <Link className="underline" to="/fantasy/$slug/draft" params={{ slug: league.slug }}>
              Draft
            </Link>
            <Link className="underline" to="/fantasy/$slug/standings" params={{ slug: league.slug }}>
              Standings
            </Link>
          </div>

          {act.error ? <p className="text-sm text-destructive">{act.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminStartDraftNow({ data: { leagueId: league.leagueId } }))}
            >
              Start draft now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminAutoPickCurrent({ data: { leagueId: league.leagueId } }))}
            >
              Auto-pick current
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminFastForwardDraft({ data: { leagueId: league.leagueId } }))}
            >
              Fast-forward draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminResetQuizAttempt({ data: { leagueId: league.leagueId } }))}
            >
              Reset my quiz
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminSeedSyntheticScores({ data: { leagueId: league.leagueId, final: false } }))}
            >
              Seed scores
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminSeedSyntheticScores({ data: { leagueId: league.leagueId, final: true } }))}
            >
              Seed final scores
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => void act.run(() => adminRecomputeStandings({ data: { season: league.season } }))}
            >
              Recompute standings
            </Button>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="destructive" disabled={act.busy}>
                  Delete
                </Button>
              }
              title={`Delete "${league.name}"?`}
              description="Removes the test league, its picks/standings/draft, and its bot users. Can't be undone."
              confirmLabel="Delete test league"
              destructive
              onConfirm={() =>
                act.run(() => adminDeleteTestLeague({ data: { leagueId: league.leagueId } }))
              }
            />
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
