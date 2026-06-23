import { useState } from 'react';
import { createFileRoute, notFound, Link, useRouter } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getLeague, getDraftState } from '@/lib/server-fns/fantasy';
import { CAPTION_KEYS, KEY_TO_CAPTION_NAME, type CaptionKey } from '@/lib/fantasy/captions';
import { useDraftStream } from '@/lib/fantasy/use-draft-stream';
import { Countdown } from '@/components/fantasy/countdown';
import { BusyButton } from '@/components/fantasy/busy-button';
import { fantasyDraftMachine, type FantasyDraftEvent } from '@/machines/fantasy-draft-machine';

type LeagueData = Awaited<ReturnType<typeof getLeague>>;
type DraftState = Awaited<ReturnType<typeof getDraftState>>;
type Member = LeagueData['members'][number];
type Send = (event: FantasyDraftEvent) => void;

export const Route = createFileRoute('/fantasy/$slug/draft')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => {
    let league: LeagueData;
    try {
      league = await getLeague({ data: { slug: params.slug } });
    } catch (e) {
      if ((e as Error).message.includes('NOT_FOUND')) throw notFound();
      throw e;
    }
    if (!league.viewer.isMember) {
      return { league, draftState: null as DraftState | null };
    }
    const draftState = await getDraftState({ data: { leagueId: league.league.leagueId } });
    return { league, draftState };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: loaderData ? `Draft — ${loaderData.league.league.name}` : 'Draft',
      description: 'Live fantasy drum corps draft.',
      path: '/fantasy',
    }),
  component: DraftPage,
});

function DraftPage() {
  const { league, draftState } = Route.useLoaderData();

  if (!draftState) {
    return (
      <PageShell className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Draft</h1>
        <p className="text-muted-foreground">You're not a member of this league.</p>
      </PageShell>
    );
  }

  return <DraftView league={league} initial={draftState} />;
}

function DraftView({ league, initial }: { league: LeagueData; initial: DraftState }) {
  const leagueId = league.league.leagueId;
  const router = useRouter();
  const snapshot = useDraftStream(leagueId, initial.snapshot) ?? initial.snapshot;
  const draft = snapshot.draft;
  const [state, send] = useMachine(fantasyDraftMachine, {
    input: { leagueId, onChanged: () => void router.invalidate() },
  });

  // React Compiler memoizes these derived maps — no manual useMemo (AGENTS.md).
  const membersById = new Map<string, Member>(league.members.map((m) => [m.user_id, m]));
  const corpsName = new Map(initial.pool.map((c) => [c.corpsKey, c.name]));

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">{league.league.name} — Draft</h1>
          <p className="text-sm text-muted-foreground">{draft ? draft.status : 'not scheduled'}</p>
        </div>
        <Button
          variant="outline"
          render={<Link to="/fantasy/$slug" params={{ slug: league.league.slug }} />}
        >
          League
        </Button>
      </header>

      {!draft || draft.status === 'scheduled' ? (
        <SchedulePanel
          send={send}
          scheduling={state.matches('scheduling')}
          starting={state.matches('starting')}
          error={state.context.error}
          feasibility={state.context.feasibility}
          isOwner={league.viewer.isOwner}
          scheduledAt={draft?.scheduledAt ?? null}
        />
      ) : draft.status === 'complete' ? (
        <CompletePanel league={league} />
      ) : (
        <LiveDraft
          send={send}
          picking={state.matches('picking')}
          actionBusy={!state.matches('ready')}
          actionError={state.context.error}
          draft={draft}
          picks={snapshot.picks}
          pool={initial.pool}
          viewerId={league.viewer.userId}
          isOwner={league.viewer.isOwner}
          membersById={membersById}
          corpsName={corpsName}
        />
      )}
    </PageShell>
  );
}

function SchedulePanel({
  send,
  scheduling,
  starting,
  error,
  feasibility,
  isOwner,
  scheduledAt,
}: {
  send: Send;
  scheduling: boolean;
  starting: boolean;
  error: string | null;
  feasibility: string | null;
  isOwner: boolean;
  scheduledAt: string | null;
}) {
  const [when, setWhen] = useState('');

  if (!isOwner) {
    return (
      <p className="text-muted-foreground">
        {scheduledAt
          ? `The draft is scheduled for ${new Date(scheduledAt).toLocaleString()}. Hang tight — the room opens when the owner starts it.`
          : 'The owner has not scheduled the draft yet.'}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule & start</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="draft-time">Draft time</Label>
            <Input
              id="draft-time"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="w-auto"
            />
          </div>
          <BusyButton
            variant="outline"
            busy={scheduling}
            disabled={!when}
            onClick={() => send({ type: 'SCHEDULE', scheduledAt: new Date(when).toISOString() })}
          >
            {scheduledAt ? 'Reschedule' : 'Schedule'}
          </BusyButton>
        </div>
        {scheduledAt ? (
          <p className="text-sm text-muted-foreground">
            Scheduled for {new Date(scheduledAt).toLocaleString()}.
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <BusyButton busy={starting} onClick={() => send({ type: 'START' })}>
            Start draft now
          </BusyButton>
          {error ? <span className="text-sm text-destructive">{error}</span> : null}
          {feasibility ? <span className="text-sm text-destructive">{feasibility}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function CompletePanel({ league }: { league: LeagueData }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-lg">The draft is complete — rosters are locked.</p>
        <Button render={<Link to="/fantasy/$slug" params={{ slug: league.league.slug }} />}>
          Back to league
        </Button>
      </CardContent>
    </Card>
  );
}

type LiveDraftProps = {
  send: Send;
  picking: boolean;
  actionBusy: boolean;
  actionError: string | null;
  draft: NonNullable<DraftState['snapshot']['draft']>;
  picks: DraftState['snapshot']['picks'];
  pool: DraftState['pool'];
  viewerId: string | null;
  isOwner: boolean;
  membersById: Map<string, Member>;
  corpsName: Map<string, string>;
};

function LiveDraft({
  send,
  picking,
  actionBusy,
  actionError,
  draft,
  picks,
  pool,
  viewerId,
  isOwner,
  membersById,
  corpsName,
}: LiveDraftProps) {
  const isMyTurn = draft.status === 'live' && draft.currentUserId === viewerId;
  const onClock = draft.currentUserId ? membersById.get(draft.currentUserId) : undefined;
  const takenPairs = new Set(picks.map((p) => `${p.corpsKey}|${p.caption}`));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">On the clock:</span>
            <span
              className="font-medium"
              style={onClock?.corps_color ? { color: onClock.corps_color } : undefined}
            >
              {onClock?.corps_name || onClock?.user_name || '—'}
            </span>
            {isMyTurn ? (
              <span className="text-sm font-semibold text-primary">Your pick!</span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {draft.status === 'paused' ? (
              <span className="font-medium text-destructive">Paused</span>
            ) : draft.pickDeadlineAt ? (
              <Countdown endsAt={draft.pickDeadlineAt} />
            ) : null}
            {isOwner && draft.status === 'live' ? (
              <BusyButton
                size="sm"
                variant="outline"
                busy={actionBusy}
                onClick={() => send({ type: 'PAUSE' })}
              >
                Pause
              </BusyButton>
            ) : null}
            {isOwner && draft.status === 'paused' ? (
              <BusyButton size="sm" busy={actionBusy} onClick={() => send({ type: 'RESUME' })}>
                Resume
              </BusyButton>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <PoolPicker
          pool={pool}
          takenPairs={takenPairs}
          canPick={isMyTurn && !picking}
          onPick={(corpsKey, caption) => send({ type: 'PICK', corpsKey, caption })}
        />
        <RosterBoard picks={picks} membersById={membersById} corpsName={corpsName} />
      </div>
    </div>
  );
}

function PoolPicker({
  pool,
  takenPairs,
  canPick,
  onPick,
}: {
  pool: DraftState['pool'];
  takenPairs: Set<string>;
  canPick: boolean;
  onPick: (corpsKey: string, caption: CaptionKey) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q ? pool.filter((c) => c.name.toLowerCase().includes(q)) : pool;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Available corps</CardTitle>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter corps…"
          className="w-48"
        />
      </CardHeader>
      <CardContent>
        <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {filtered.map((corps) => (
            <li key={corps.corpsKey} className="rounded-lg border border-border p-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <span>{corps.name}</span>
                <span className="text-xs text-muted-foreground">{corps.divisionName}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {CAPTION_KEYS.map((caption) => {
                  const taken = takenPairs.has(`${corps.corpsKey}|${caption}`);
                  return (
                    <Button
                      key={caption}
                      size="xs"
                      variant={taken ? 'ghost' : 'outline'}
                      disabled={taken || !canPick}
                      title={`${KEY_TO_CAPTION_NAME[caption]}${taken ? ' — already drafted' : ''}`}
                      onClick={() => onPick(corps.corpsKey, caption)}
                    >
                      {caption}
                    </Button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RosterBoard({
  picks,
  membersById,
  corpsName,
}: {
  picks: DraftState['snapshot']['picks'];
  membersById: Map<string, Member>;
  corpsName: Map<string, string>;
}) {
  const byMember = new Map<string, DraftState['snapshot']['picks']>();
  for (const p of picks) {
    const list = byMember.get(p.userId) ?? [];
    list.push(p);
    byMember.set(p.userId, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rosters</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {[...membersById.values()].map((m) => {
          const roster = byMember.get(m.user_id) ?? [];
          return (
            <div key={m.user_id} className="rounded-lg border border-border p-2">
              <p
                className="text-sm font-medium"
                style={m.corps_color ? { color: m.corps_color } : undefined}
              >
                {m.corps_name || m.user_name || 'Player'} · {roster.length}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                {roster.map((p) => (
                  <li key={p.pickNo}>
                    <span className="font-mono" title={KEY_TO_CAPTION_NAME[p.caption]}>
                      {p.caption}
                    </span>{' '}
                    {corpsName.get(p.corpsKey) ?? p.corpsKey}
                    {p.autoPicked ? ' (auto)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
