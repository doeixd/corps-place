import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { createFileRoute, notFound, Link, useRouter } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { LeagueTabs } from '@/components/fantasy/league-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { cn } from '@/lib/utils';
import { useAsyncAction } from '@/lib/use-async-action';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import {
  getLeague,
  getDraftState,
  getDraftPage,
  getDraftQueue,
  setDraftQueue,
} from '@/lib/server-fns/fantasy';
import { CAPTION_KEYS, KEY_TO_CAPTION_NAME, type CaptionKey } from '@/lib/fantasy/captions';
import { pickWeight, type ReverseWeighting } from '@/lib/fantasy/draft';
import { useDraftStream, useDraftPresence } from '@/lib/fantasy/use-draft-stream';
import { DraftScheduleFields } from '@/components/fantasy/draft-schedule-fields';
import { useWebHaptics } from 'web-haptics/react';
import { Countdown } from '@/components/fantasy/countdown';
import { BusyButton } from '@/components/fantasy/busy-button';
import { fantasyDraftMachine, type FantasyDraftEvent } from '@/machines/fantasy-draft-machine';
import { SectionErrorBoundary } from '@/components/error-boundary';

type LeagueData = Awaited<ReturnType<typeof getLeague>>;
type DraftState = Awaited<ReturnType<typeof getDraftState>>;
type Member = LeagueData['members'][number];
type Send = (event: FantasyDraftEvent) => void;
type PoolCorps = DraftState['pool'][number];

// Theme-aware logo source for a pool corps — renders the dark-mode variant
// (auto-invert or a dark asset) via CorpsLogo instead of one fixed image.
const draftLogo = (c: PoolCorps | undefined) =>
  corpsLogoSource({
    corps_logo: c?.corpsLogo ?? null,
    corps_logo_dark: c?.corpsLogoDark ?? null,
    corps_logo_dark_url: c?.corpsLogoDarkUrl ?? null,
  });

export const Route = createFileRoute('/fantasy/$slug/draft')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => {
    // Single round-trip: league + draft state together (no league→draftState waterfall).
    try {
      return (await getDraftPage({ data: { slug: params.slug } })) as {
        league: LeagueData;
        draftState: DraftState | null;
      };
    } catch (e) {
      if ((e as Error).message.includes('NOT_FOUND')) throw notFound();
      throw e;
    }
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
  const online = new Set(useDraftPresence(leagueId));
  const draft = snapshot.draft;
  const [state, send] = useMachine(fantasyDraftMachine, {
    input: { leagueId, onChanged: () => void router.invalidate() },
  });

  // Surface pick/schedule/start errors (caption full, not your turn, …) as a toast.
  const draftError = state.context.error;
  useEffect(() => {
    if (draftError) toast.error(draftError);
  }, [draftError]);

  // React Compiler memoizes this derived map — no manual useMemo (AGENTS.md).
  const membersById = new Map<string, Member>(league.members.map((m) => [m.user_id, m]));

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="space-y-3">
        <BackLink to="/fantasy/$slug" params={{ slug: league.league.slug }} label="League home" />
        <div className="space-y-1">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {league.league.name} · Season {league.league.season}
          </p>
          <h1 className="text-2xl font-bold text-text-primary">Draft room</h1>
          <p className="text-sm text-text-secondary">{draft ? draft.status : 'not scheduled'}</p>
        </div>
        <LeagueTabs
          slug={league.league.slug}
          active="draft"
          isMember={league.viewer.isMember}
          quizEnabled={league.league.config.quiz.enabled}
        />
      </header>

      <details className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-text-primary">
          How the draft works
        </summary>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          <li>
            Players take turns. When you&apos;re <strong>on the clock</strong>, you can draft a corps
            for <strong>any caption you want — in any order</strong>. Switch caption tabs freely;
            you&apos;re never forced to fill them top-to-bottom.
          </li>
          <li>
            Each <strong>caption</strong> (GE1, VP, MB, …) has a set number of slots for your lineup.
            Fill them across your turns in whatever order you like — the same corps + caption can
            only be taken once in the league.
          </li>
          <li>
            Picks are <strong>weighted by slot</strong>: within a caption, the <strong>later slots
            count for more</strong> — your 2nd corps in a caption is worth more than your 1st, and so
            on. The exact weight is shown on the picker (before you pick) and on the board.
          </li>
          <li>
            Set a <strong>draft queue</strong> (the button below) and if your timer runs out we
            auto-pick your highest-ranked available corps for you.
          </li>
          <li>
            The <strong>draft board</strong> lists everyone&apos;s picks and weights as they happen.
            Scores are tallied from real drum corps results once the season starts.
          </li>
        </ul>
      </details>

      {draft && draft.status !== 'complete' && league.viewer.isMember ? (
        <div className="flex justify-end">
          <DraftQueueEditor leagueId={leagueId} pool={initial.pool} rank={initial.rank} />
        </div>
      ) : null}

      {draft?.status === 'scheduled' ? <ProjectedOrder league={league} online={online} /> : null}

      <SectionErrorBoundary label="the draft room">
        {!draft || draft.status === 'scheduled' ? (
          <SchedulePanel
            send={send}
            scheduling={state.matches('scheduling')}
            starting={state.matches('starting')}
            error={state.context.error}
            feasibility={state.context.feasibility}
            isOwner={league.viewer.isOwner}
            scheduledAt={draft?.scheduledAt ?? null}
            savedAutoStart={draft?.autoStart ?? false}
          />
        ) : draft.status === 'complete' ? (
          <CompletePanel
            league={league}
            picks={snapshot.picks}
            pool={initial.pool}
            members={[...membersById.values()]}
          />
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
            online={online}
            captionCaps={league.league.config.captionCaps}
            reverseWeighting={league.league.config.reverseWeighting}
          />
        )}
      </SectionErrorBoundary>
    </PageShell>
  );
}

/** Pre-draft seeding preview (§ P3) — the projected pick order from quiz scores. */
function ProjectedOrder({ league, online }: { league: LeagueData; online: Set<string> }) {
  const byId = new Map(league.members.map((m) => [m.user_id, m]));
  const anyQuiz = league.members.some((m) => m.quiz_taken);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Projected draft order</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {anyQuiz ? (
          <ol className="flex flex-col gap-1 text-sm">
            {league.draftOrderPreview.map((uid, i) => {
              const m = byId.get(uid);
              return (
                <li key={uid} className="flex items-center gap-2">
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                  <PresenceDot online={online.has(uid)} />
                  <span
                    className="font-medium"
                    style={m?.corps_color ? { color: m.corps_color } : undefined}
                  >
                    {m?.corps_name || m?.user_name || 'Player'}
                  </span>
                  {m?.role === 'owner' ? <OwnerBadge /> : null}
                  {!m?.quiz_taken ? (
                    <span className="text-xs text-muted-foreground">(quiz not taken)</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            The order is set by quiz scores — it&apos;ll appear here as members take the quiz.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Projected from quiz scores so far; the final order locks when the draft starts.
        </p>
      </CardContent>
    </Card>
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
  savedAutoStart,
}: {
  send: Send;
  scheduling: boolean;
  starting: boolean;
  error: string | null;
  feasibility: string | null;
  isOwner: boolean;
  scheduledAt: string | null;
  savedAutoStart: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-render once the scheduled time passes so a manual-mode room can flip its
  // "waiting on the owner" message live (the SSE feed only fires on draft events,
  // and no event happens when a manual draft's time simply arrives).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (isOwner || !scheduledAt || savedAutoStart) return;
    const at = new Date(scheduledAt).getTime();
    if (Number.isNaN(at) || Date.now() >= at) return;
    const t = setTimeout(() => setNowMs(Date.now()), at - Date.now() + 500);
    return () => clearTimeout(t);
  }, [isOwner, scheduledAt, savedAutoStart]);

  // Starting the draft is a one-way door. Confirm when it would start a draft with no
  // set time, or earlier than the scheduled time — to avoid catching players off guard.
  const handleStartClick = () => {
    const sched = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (sched == null || Date.now() < sched) setConfirmOpen(true);
    else send({ type: 'START' });
  };

  if (!isOwner) {
    const sched = scheduledAt ? new Date(scheduledAt).getTime() : null;
    const timeArrived = sched != null && !Number.isNaN(sched) && nowMs >= sched;
    // Manual mode + the scheduled time has arrived → the room won't open on its
    // own; make it clear everyone is waiting on the owner to hit start.
    if (scheduledAt && !savedAutoStart && timeArrived) {
      return (
        <p className="text-sm font-medium text-foreground">
          The scheduled draft time has arrived — waiting on the owner to start the draft.
        </p>
      );
    }
    return (
      <p className="text-muted-foreground">
        {scheduledAt
          ? `The draft is scheduled for ${new Date(scheduledAt).toLocaleString()}. ${
              savedAutoStart
                ? 'It will open automatically at that time.'
                : 'The room opens when the owner starts it.'
            }`
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
        <DraftScheduleFields
          scheduledAt={scheduledAt}
          savedAutoStart={savedAutoStart}
          scheduling={scheduling}
          onSchedule={(at, auto) => send({ type: 'SCHEDULE', scheduledAt: at, autoStart: auto })}
        />
        <div className="flex items-center gap-3">
          <BusyButton busy={starting} onClick={handleStartClick}>
            Start draft now
          </BusyButton>
          {feasibility ? <span className="text-sm text-destructive">{feasibility}</span> : null}
        </div>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent className="max-w-md">
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              {scheduledAt ? (
                <>
                  The draft is scheduled for{' '}
                  <strong>{new Date(scheduledAt).toLocaleString()}</strong>, which hasn&apos;t
                  arrived yet. Starting now begins it <strong>early</strong> — anyone counting on
                  the scheduled time may not be in the room yet. Make sure every player is here and
                  ready, because the draft can&apos;t go back to setup once it starts.
                </>
              ) : (
                <>
                  You haven&apos;t set a draft time yet. Starting now opens the draft room{' '}
                  <strong>immediately</strong> and puts the first player on the clock. Make sure
                  everyone has joined, named their corps, and is ready — the draft can&apos;t go back
                  to setup once it begins.
                </>
              )}
            </DialogDescription>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmOpen(false);
                  send({ type: 'START' });
                }}
              >
                Start draft now
              </Button>
              <Button autoFocus onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function CompletePanel({
  league,
  picks,
  pool,
  members,
}: {
  league: LeagueData;
  picks: DraftState['snapshot']['picks'];
  pool: DraftState['pool'];
  members: Member[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-lg">The draft is complete — rosters are locked.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              render={<Link to="/fantasy/$slug/standings" params={{ slug: league.league.slug }} />}
            >
              View standings
            </Button>
            <Button
              variant="outline"
              render={<Link to="/fantasy/$slug" params={{ slug: league.league.slug }} />}
            >
              Back to league
            </Button>
          </div>
        </CardContent>
      </Card>
      <DraftBoard
        picks={picks}
        members={members}
        pool={pool}
        currentUserId={null}
        captionCaps={league.league.config.captionCaps}
      />
    </div>
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
  online: Set<string>;
  captionCaps: Record<CaptionKey, number>;
  reverseWeighting: ReverseWeighting;
};

// Online/offline indicator for a player — driven by live SSE presence.
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? 'Online' : 'Offline'}
      aria-label={online ? 'Online' : 'Offline'}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online ? 'bg-green-500' : 'bg-muted-foreground/30'
      )}
    />
  );
}

// Marks the league owner in a member/order list.
function OwnerBadge() {
  return (
    <span
      title="League owner"
      className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      Owner
    </span>
  );
}

function LiveDraft({
  send,
  picking,
  actionBusy,
  actionError,
  draft,
  picks,
  pool,
  captionCaps,
  reverseWeighting,
  rank,
  viewerId,
  isOwner,
  membersById,
  online,
}: LiveDraftProps) {
  const isMyTurn = draft.status === 'live' && draft.currentUserId === viewerId;

  // A cute little buzz the moment it becomes your turn (web-haptics → Vibration API on
  // Android; a harmless no-op on iOS/desktop where it isn't supported).
  const { trigger: haptic } = useWebHaptics();
  useEffect(() => {
    if (isMyTurn) void haptic('success');
    // haptic identity isn't depended on — we only want to fire on the turn transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn]);

  const onClock = draft.currentUserId ? membersById.get(draft.currentUserId) : undefined;
  const takenPairs = new Set(picks.map((p) => `${p.corpsKey}|${p.caption}`));
  const memberCount = membersById.size;
  const round = memberCount > 0 ? Math.floor(draft.currentPickNo / memberCount) + 1 : 1;

  // The viewer's pick count per caption — drives both the next-pick weight (weight
  // is by slot within the caption) and the filled-caption dimming.
  const myCaptionCount = new Map<CaptionKey, number>();
  for (const p of picks) {
    if (p.userId === viewerId)
      myCaptionCount.set(p.caption, (myCaptionCount.get(p.caption) ?? 0) + 1);
  }
  // Weight the viewer's NEXT pick in caption `c` would score — its slot in that
  // caption (later slots are worth more).
  const nextWeightFor = (c: CaptionKey): number =>
    pickWeight((myCaptionCount.get(c) ?? 0) + 1, captionCaps[c] ?? 1, reverseWeighting);

  // Captions the viewer has already filled (picked the full cap) — dimmed in the tabs.
  const filledCaptions = new Set(
    CAPTION_KEYS.filter((c) => {
      const cap = captionCaps[c] ?? 0;
      return cap > 0 && (myCaptionCount.get(c) ?? 0) >= cap;
    })
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Screen-reader announcement of turn changes (plan §3.7). */}
      <div className="sr-only" role="status" aria-live="polite">
        {draft.status === 'paused'
          ? 'The draft is paused.'
          : isMyTurn
            ? "You're on the clock — make your pick."
            : onClock
              ? `${onClock.corps_name || onClock.user_name || 'A player'} is on the clock.`
              : ''}
      </div>

      <Card className={cn('transition-colors', isMyTurn && 'border-primary ring-1 ring-primary')}>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {onClock?.corps_logo_media_id ? (
              <img
                src={`/api/fantasy-media/${onClock.corps_logo_media_id}`}
                alt=""
                className="size-9 rounded-lg object-cover"
              />
            ) : (
              <div
                className="size-9 rounded bg-muted"
                style={onClock?.corps_color ? { backgroundColor: onClock.corps_color } : undefined}
              />
            )}
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">
                {isMyTurn ? "You're on the clock" : 'On the clock'}
              </span>
              <span
                className="flex items-center gap-1.5 font-semibold"
                style={onClock?.corps_color ? { color: onClock.corps_color } : undefined}
              >
                {onClock?.corps_name || onClock?.user_name || '—'}
                {draft.currentUserId ? (
                  <PresenceDot online={online.has(draft.currentUserId)} />
                ) : null}
              </span>
            </div>
            {isMyTurn ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                Your pick!
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              Round {round} · Pick {draft.currentPickNo + 1}
            </span>
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


      <DraftBoard
        picks={picks}
        members={[...membersById.values()]}
        pool={pool}
        currentUserId={draft.currentUserId}
        captionCaps={captionCaps}
        online={online}
      />

      {/* Picking is the primary, time-pressured action, so it's inline + always
          visible (no modal) on every screen — the board stays in view for context,
          and the caption tabs hold their place while the corps list scrolls under
          them. (The drawer is reserved for the calmer pre-draft queue editor.) */}
      <Card>
        <CardHeader>
          <CardTitle>Available corps</CardTitle>
        </CardHeader>
        <CardContent>
          <SectionPicker
            pool={pool}
            rank={rank}
            takenPairs={takenPairs}
            canPick={isMyTurn && !picking}
            nextWeightFor={nextWeightFor}
            filledCaptions={filledCaptions}
            onPick={(corpsKey, caption) => send({ type: 'PICK', corpsKey, caption })}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The draft-queue editor (UI/UX plan §12.5) — the drawer's home: a calm,
 * non-time-pressured surface where a member pre-ranks an auto-pick wishlist. If
 * their timer runs out, the engine takes the highest still-legal entry
 * (chooseAutoPick). Reorder with arrows; add from the rank-ordered pool per caption.
 */
function DraftQueueEditor({
  leagueId,
  pool,
  rank,
}: {
  leagueId: string;
  pool: DraftState['pool'];
  rank: DraftState['rank'];
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [queue, setQueue] = useState<Array<{ corpsKey: string; caption: CaptionKey }>>([]);
  const [caption, setCaption] = useState<CaptionKey>('GE1');

  const load = useAsyncAction(async () => {
    const res = await getDraftQueue({ data: { leagueId } });
    setQueue(res.entries.map((e) => ({ corpsKey: e.corpsKey, caption: e.caption ?? 'GE1' })));
    setLoaded(true);
  });
  const save = useAsyncAction(async () => {
    await setDraftQueue({ data: { leagueId, entries: queue } });
    setOpen(false);
  });

  const corpsByKey = new Map(pool.map((c) => [c.corpsKey, c]));
  const queuedKeys = new Set(queue.map((e) => `${e.corpsKey}|${e.caption}`));
  const ranked = [...pool].sort(
    (a, b) =>
      (rank[`${b.corpsKey}|${caption}`] ?? -Infinity) -
      (rank[`${a.corpsKey}|${caption}`] ?? -Infinity)
  );

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= queue.length) return;
    const next = [...queue];
    [next[i], next[j]] = [next[j], next[i]];
    setQueue(next);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && !loaded) void load.run();
      }}
    >
      <DrawerTrigger
        render={
          <Button variant="outline" size="sm">
            Draft queue{queue.length > 0 ? ` (${queue.length})` : ''}
          </Button>
        }
      />
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Your draft queue</DrawerTitle>
          <DrawerDescription>
            If your pick timer runs out, we auto-pick the highest entry that&apos;s still available.
            Reorder with the arrows.
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          <ol className="flex flex-col gap-1">
            {queue.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Your queue is empty — add corps from the list below.
              </p>
            ) : (
              queue.map((e, i) => (
                <li
                  key={`${e.corpsKey}|${e.caption}`}
                  className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm"
                >
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <CorpsLogo
                    name={corpsByKey.get(e.corpsKey)?.name ?? e.corpsKey}
                    logo={draftLogo(corpsByKey.get(e.corpsKey))}
                    width={24}
                    className="size-6"
                  />
                  <span className="font-medium">
                    {corpsByKey.get(e.corpsKey)?.name ?? e.corpsKey}
                  </span>
                  <span className="text-xs text-muted-foreground">{e.caption}</span>
                  <div className="ml-auto flex gap-0.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      aria-label="Move up"
                    >
                      ↑
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={i === queue.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setQueue(queue.filter((_, k) => k !== i))}
                      aria-label="Remove"
                    >
                      ✕
                    </Button>
                  </div>
                </li>
              ))
            )}
          </ol>

          <div className="flex flex-col gap-2">
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
            <ul className="flex max-h-[35vh] flex-col gap-1 overflow-y-auto">
              {ranked.map((corps) => {
                const already = queuedKeys.has(`${corps.corpsKey}|${caption}`);
                return (
                  <li key={corps.corpsKey}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => setQueue([...queue, { corpsKey: corps.corpsKey, caption }])}
                      className="flex w-full items-center gap-2 rounded-lg border border-border p-2 text-left text-sm hover:bg-muted disabled:opacity-40"
                    >
                      <CorpsLogo
                        name={corps.name}
                        logo={draftLogo(corps)}
                        width={24}
                        className="size-6"
                      />
                      <span className="font-medium">{corps.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {already ? 'queued' : '+ add'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <DrawerFooter>
          <BusyButton busy={save.busy} onClick={() => void save.run()}>
            Save queue
          </BusyButton>
          {save.error ? <p className="text-sm text-destructive">{save.error}</p> : null}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
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
  nextWeightFor,
  filledCaptions,
  onPick,
}: {
  pool: DraftState['pool'];
  rank: DraftState['rank'];
  takenPairs: Set<string>;
  canPick: boolean;
  nextWeightFor: (caption: CaptionKey) => number;
  filledCaptions: Set<CaptionKey>;
  onPick: (corpsKey: string, caption: CaptionKey) => void;
}) {
  const [caption, setCaption] = useState<CaptionKey>('GE1');
  const nextWeight = nextWeightFor(caption);

  if (pool.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Draftable corps aren&apos;t available right now — the pool appears once this season&apos;s
        corps data is published.
      </p>
    );
  }

  // Each corps' OVERALL latest-finals standing = the total of its finals caption
  // scores. One rank per corps (its finishing place), shown the same for every
  // caption — not a per-caption position. Corps that didn't make finals have none.
  const finalsTotal = (corpsKey: string): number | null => {
    let total = 0;
    let any = false;
    for (const cap of CAPTION_KEYS) {
      const s = rank[`${corpsKey}|${cap}`];
      if (s != null) {
        total += s;
        any = true;
      }
    }
    return any ? total : null;
  };
  const totals = new Map(pool.map((c) => [c.corpsKey, finalsTotal(c.corpsKey)]));
  const ranked = [...pool].sort(
    (a, b) => (totals.get(b.corpsKey) ?? -Infinity) - (totals.get(a.corpsKey) ?? -Infinity)
  );
  // #1 = highest prior-finals total; ranks are stable across caption tabs.
  const rankByKey = new Map<string, number>();
  let nextRank = 0;
  for (const c of ranked) {
    if (totals.get(c.corpsKey) != null) rankByKey.set(c.corpsKey, ++nextRank);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Pick <strong>any caption</strong> — tap a tab in any order, then choose a corps.{' '}
        <span className="font-medium text-text-primary">
          This {caption} pick scores ×{nextWeight.toFixed(2)}
        </span>{' '}
        toward your total — later slots in a caption are worth more, so save your best corps for them.
      </p>
      <ToggleGroup
        value={[caption]}
        onValueChange={(v) => {
          const c = v[v.length - 1];
          if (c) setCaption(c as CaptionKey);
        }}
        className="flex-wrap"
      >
        {CAPTION_KEYS.map((c) => {
          const filled = filledCaptions.has(c);
          return (
            <ToggleGroupItem
              key={c}
              value={c}
              title={`${KEY_TO_CAPTION_NAME[c]}${filled ? ' — filled' : ''}`}
              className={cn(filled && 'text-text-secondary/50')}
            >
              {filled ? '✓ ' : ''}
              {c}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      <div className="flex items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
        <span className="w-8 shrink-0 text-center">Rank</span>
        <span>Corps</span>
      </div>

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
                <span
                  className="w-8 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground"
                  title="Previous-season rank in this caption"
                >
                  {rankByKey.has(corps.corpsKey) ? `#${rankByKey.get(corps.corpsKey)}` : '—'}
                </span>
                <CorpsLogo
                  name={corps.name}
                  logo={draftLogo(corps)}
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
 * The draft board — a flat list of every pick, grouped per player (the player cell
 * row-spans their picks). Columns: Corps, Caption, and the scoring Weight of each
 * pick (later picks weigh more under reverse weighting). Collapsible.
 */
function DraftBoard({
  picks,
  members,
  pool,
  currentUserId,
  captionCaps,
  online,
}: {
  picks: DraftState['snapshot']['picks'];
  members: Member[];
  pool: DraftState['pool'];
  currentUserId: string | null;
  captionCaps: Record<CaptionKey, number>;
  online?: Set<string>;
}) {
  const corpsByKey = new Map(pool.map((c) => [c.corpsKey, c]));

  // Every pick per (player, caption), in draft order — a caption can hold more
  // than one corps (captionCaps), so each fills its own slot/row.
  const cell = new Map<string, DraftState['snapshot']['picks']>();
  for (const p of [...picks].sort((a, b) => a.pickNo - b.pickNo)) {
    const k = `${p.userId}|${p.caption}`;
    const arr = cell.get(k);
    if (arr) arr.push(p);
    else cell.set(k, [p]);
  }
  // One row per slot depth; the tallest caption sets how many rows a player spans.
  const maxCap = Math.max(1, ...CAPTION_KEYS.map((c) => captionCaps[c] ?? 1));
  const slots = Array.from({ length: maxCap }, (_, i) => i);

  // Logo size scales with the pick's scoring weight, so heavier picks sit larger
  // and their rows grow taller — the board reads as "how much each corps counts."
  // Relative to the weights actually on the board (any min/max config; all-equal
  // weights collapse to a single mid size).
  const weights = picks.map((p) => p.weight);
  const minW = weights.length ? Math.min(...weights) : 0;
  const maxW = weights.length ? Math.max(...weights) : 0;
  const logoSize = (w: number): number =>
    maxW <= minW ? 34 : Math.round(24 + 26 * ((w - minW) / (maxW - minW))); // 24–50px

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft board</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
          <p className="mb-2 text-xs text-muted-foreground">
            Each corps shows its scoring weight (×) — bigger logos count for more. Captions
            that hold more than one corps stack down the rows.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-20 bg-card">Player</TableHead>
                {CAPTION_KEYS.map((c) => (
                  <TableHead key={c} className="px-2 text-center text-xs" title={c}>
                    {KEY_TO_CAPTION_NAME[c]}
                    {(captionCaps[c] ?? 1) > 1 ? (
                      <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
                        ×{captionCaps[c]}
                      </span>
                    ) : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) =>
                slots.map((slot) => (
                  <TableRow
                    key={`${m.user_id}-${slot}`}
                    className={cn(
                      m.user_id === currentUserId && 'bg-muted/40',
                      slot > 0 && 'border-t-0'
                    )}
                  >
                    {slot === 0 ? (
                      <TableCell
                        rowSpan={maxCap}
                        className="sticky left-0 z-20 bg-card align-middle font-medium whitespace-nowrap"
                        style={m.corps_color ? { color: m.corps_color } : undefined}
                      >
                        <span className="flex items-center gap-1.5">
                          {online ? <PresenceDot online={online.has(m.user_id)} /> : null}
                          {m.corps_name || m.user_name || 'Player'}
                          {m.role === 'owner' ? <OwnerBadge /> : null}
                        </span>
                      </TableCell>
                    ) : null}
                    {CAPTION_KEYS.map((c) => {
                      const cap = captionCaps[c] ?? 1;
                      // This caption holds fewer corps than the tallest column — no slot here.
                      if (slot >= cap)
                        return <TableCell key={c} className="bg-muted/15 p-1" aria-hidden />;
                      const pick = cell.get(`${m.user_id}|${c}`)?.[slot];
                      const corps = pick ? corpsByKey.get(pick.corpsKey) : undefined;
                      const size = pick ? logoSize(pick.weight) : 0;
                      return (
                        <TableCell key={c} className="p-1 text-center align-middle">
                          {pick ? (
                            <span
                              className="inline-flex flex-col items-center gap-0.5"
                              title={`${corps?.name ?? pick.corpsKey} — ${KEY_TO_CAPTION_NAME[c]}${pick.autoPicked ? ' (auto-pick)' : ''}`}
                            >
                              <span
                                className="grid shrink-0 place-items-center"
                                style={{ width: size, height: size }}
                              >
                                <CorpsLogo
                                  name={corps?.name ?? pick.corpsKey}
                                  logo={draftLogo(corps)}
                                  width={size}
                                  className="h-full w-full"
                                />
                              </span>
                              <span className="text-[10px] leading-none tabular-nums text-muted-foreground">
                                ×{pick.weight.toFixed(1)}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">·</span>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
    </Card>
  );
}
