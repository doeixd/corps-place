import { useState } from 'react';
import { createFileRoute, notFound, Link, useRouter } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { CorpsLogo } from '@/components/corps-logo';
import { cn } from '@/lib/utils';
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

  // React Compiler memoizes this derived map — no manual useMemo (AGENTS.md).
  const membersById = new Map<string, Member>(league.members.map((m) => [m.user_id, m]));

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
          rank={initial.rank}
          viewerId={league.viewer.userId}
          isOwner={league.viewer.isOwner}
          membersById={membersById}
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
  rank: DraftState['rank'];
  viewerId: string | null;
  isOwner: boolean;
  membersById: Map<string, Member>;
};

function LiveDraft({
  send,
  picking,
  actionBusy,
  actionError,
  draft,
  picks,
  pool,
  rank,
  viewerId,
  isOwner,
  membersById,
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

      <DraftBoard
        picks={picks}
        members={[...membersById.values()]}
        pool={pool}
        currentUserId={draft.currentUserId}
      />

      {/* Desktop: the section picker inline. Mobile: behind a bottom-sheet drawer. */}
      <Card className="hidden md:block">
        <CardHeader>
          <CardTitle>Available corps</CardTitle>
        </CardHeader>
        <CardContent>
          <SectionPicker
            pool={pool}
            rank={rank}
            takenPairs={takenPairs}
            canPick={isMyTurn && !picking}
            onPick={(corpsKey, caption) => send({ type: 'PICK', corpsKey, caption })}
          />
        </CardContent>
      </Card>
      <div className="md:hidden">
        <Drawer>
          <DrawerTrigger
            render={
              <Button className="w-full" disabled={!isMyTurn || picking}>
                {isMyTurn ? 'Make your pick' : 'View available corps'}
              </Button>
            }
          />
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Available corps</DrawerTitle>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-4">
              <SectionPicker
                pool={pool}
                rank={rank}
                takenPairs={takenPairs}
                canPick={isMyTurn && !picking}
                onPick={(corpsKey, caption) => send({ type: 'PICK', corpsKey, caption })}
              />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
}

/**
 * The section picker (UI/UX plan §12.5 board redesign): an exclusive caption
 * toggle, then every available corps for that caption listed in previous-season
 * rank order, with already-taken (corps, caption) pairs grayed out. Rendered
 * inline on desktop and inside the bottom-sheet Drawer on mobile.
 */
function SectionPicker({
  pool,
  rank,
  takenPairs,
  canPick,
  onPick,
}: {
  pool: DraftState['pool'];
  rank: DraftState['rank'];
  takenPairs: Set<string>;
  canPick: boolean;
  onPick: (corpsKey: string, caption: CaptionKey) => void;
}) {
  const [caption, setCaption] = useState<CaptionKey>('GE1');

  if (pool.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Draftable corps aren&apos;t available right now — the pool appears once this season&apos;s
        corps data is published.
      </p>
    );
  }

  // Order this caption's corps by previous-season rank (highest first); unranked last.
  const ranked = [...pool].sort(
    (a, b) =>
      (rank[`${b.corpsKey}|${caption}`] ?? -Infinity) -
      (rank[`${a.corpsKey}|${caption}`] ?? -Infinity)
  );

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        value={[caption]}
        onValueChange={(v) => {
          const c = v[v.length - 1];
          if (c) setCaption(c as CaptionKey);
        }}
        className="flex-wrap"
      >
        {CAPTION_KEYS.map((c) => (
          <ToggleGroupItem key={c} value={c} title={KEY_TO_CAPTION_NAME[c]}>
            {c}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <ul className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
        {ranked.map((corps) => {
          const taken = takenPairs.has(`${corps.corpsKey}|${caption}`);
          return (
            <li key={corps.corpsKey}>
              <button
                type="button"
                disabled={taken || !canPick}
                onClick={() => onPick(corps.corpsKey, caption)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border border-border p-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent',
                  taken && 'opacity-40'
                )}
              >
                <CorpsLogo
                  name={corps.name}
                  logo={corps.corpsLogo ?? ''}
                  width={28}
                  className="size-7"
                />
                <span className="font-medium">{corps.name}</span>
                <span className="text-xs text-muted-foreground">{corps.divisionName}</span>
                {taken ? (
                  <span className="ml-auto text-xs text-muted-foreground">taken</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The draft board — a compact grid like the recap table, but cells are the corps
 * LOGO each participant drafted for that caption (tooltip = corps + caption).
 * Rows are participants; columns are the caption sections. The on-clock member's
 * row is highlighted. Horizontally scrollable on narrow screens.
 */
function DraftBoard({
  picks,
  members,
  pool,
  currentUserId,
}: {
  picks: DraftState['snapshot']['picks'];
  members: Member[];
  pool: DraftState['pool'];
  currentUserId: string | null;
}) {
  const corpsByKey = new Map(pool.map((c) => [c.corpsKey, c]));
  const pickAt = new Map<string, DraftState['snapshot']['picks'][number]>();
  for (const p of picks) pickAt.set(`${p.userId}|${p.caption}`, p);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft board</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background">Player</TableHead>
              {CAPTION_KEYS.map((c) => (
                <TableHead key={c} className="px-2 text-center" title={KEY_TO_CAPTION_NAME[c]}>
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow
                key={m.user_id}
                className={m.user_id === currentUserId ? 'bg-muted/40' : undefined}
              >
                <TableCell
                  className="sticky left-0 bg-background font-medium whitespace-nowrap"
                  style={m.corps_color ? { color: m.corps_color } : undefined}
                >
                  {m.corps_name || m.user_name || 'Player'}
                </TableCell>
                {CAPTION_KEYS.map((c) => {
                  const pick = pickAt.get(`${m.user_id}|${c}`);
                  const corps = pick ? corpsByKey.get(pick.corpsKey) : undefined;
                  return (
                    <TableCell key={c} className="p-1 text-center">
                      {pick ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="mx-auto inline-flex size-8 items-center justify-center" />
                            }
                          >
                            <CorpsLogo
                              name={corps?.name ?? pick.corpsKey}
                              logo={corps?.corpsLogo ?? ''}
                              width={32}
                              className="size-8"
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            {corps?.name ?? pick.corpsKey} — {KEY_TO_CAPTION_NAME[c]}
                            {pick.autoPicked ? ' (auto)' : ''}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">·</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
