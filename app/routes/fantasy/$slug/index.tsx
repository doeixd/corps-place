import { useState, useEffect } from 'react';
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { LeagueTabs } from '@/components/fantasy/league-tabs';
import { NoteEditIcon } from '@/components/icons/generated';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import {
  getLeague,
  createInvite,
  createLeagueCheckout,
  requestRefund,
  renameLeague,
  setLeagueImage,
  leaveLeague,
  cancelLeague,
} from '@/lib/server-fns/fantasy';
import { uploadFantasyLogo } from '@/lib/server-fns/fantasy-media';
import { PhotoUpload, fileToBase64 } from '@/components/fantasy/photo-upload';
import { ConfirmDialog } from '@/components/fantasy/confirm-dialog';
import { LeagueSettings } from '@/components/fantasy/league-settings';
import { CorpsIdentityForm } from '@/components/fantasy/corps-identity-form';
import { PushToggle } from '@/components/fantasy/push-toggle';
import { NotificationPrefs } from '@/components/fantasy/notification-prefs';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard';
import { leagueDetailCollection, refetchLeagueDetail } from '@/db/fantasy-collections';
import { HybridRecord } from '@/components/hybrid-collection';

type LeagueData = Awaited<ReturnType<typeof getLeague>>;
type Member = LeagueData['members'][number];

// One plain-language line per league phase, so members always know what's
// happening and what comes next (the core "explain what's going on" ask).
const STATUS_NARRATION: Record<string, string> = {
  setup:
    'Getting set up — name your corps and invite players. The owner opens the quiz once everyone has joined.',
  quiz: 'Quiz time — members take the knowledge quiz to earn their draft position. The owner schedules the draft when ready.',
  scheduled:
    'Draft scheduled — everyone meets in the draft room at draft time to pick corps and captions for their lineup.',
  active:
    'Season underway — scores update automatically from real drum corps results as competitions are recapped. Watch the standings.',
  complete: 'Season complete — check the final standings to see who won.',
};

export const Route = createFileRoute('/fantasy/$slug/')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => {
    try {
      return await getLeague({ data: { slug: params.slug } });
    } catch (e) {
      if ((e as Error).message.includes('NOT_FOUND')) throw notFound();
      throw e;
    }
  },
  head: ({ loaderData }) =>
    seoHead({
      title: loaderData ? `${loaderData.league.name} — Fantasy Drum Corps` : 'Fantasy Drum Corps',
      description: 'A private fantasy drum corps league.',
      path: loaderData ? `/fantasy/${loaderData.league.slug}` : '/fantasy',
    }),
  component: LeagueDashboard,
});

function LeagueDashboard() {
  const data = Route.useLoaderData();
  const { slug } = Route.useParams();
  // Loader SSRs first paint; the live per-slug record drives the page after
  // hydration, and mutations below refresh it via refetchLeagueDetail(slug).
  return (
    <HybridRecord collection={leagueDetailCollection(slug)} loader={data}>
      {(d) => <LeagueDashboardContent data={d} slug={slug} />}
    </HybridRecord>
  );
}

function LeagueDashboardContent({ data, slug }: { data: LeagueData; slug: string }) {
  const { league, members, viewer, paymentsEnabled } = data;
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  // Refresh both the loader cache (for SSR/next nav) and the live collection (for
  // the currently displayed page) after a mutation changes league data.
  const refresh = async () => {
    await Promise.all([router.invalidate(), refetchLeagueDetail(slug)]);
  };

  const me = members.find((m) => m.user_id === viewer.userId);
  const needsIdentity = viewer.isMember && !me?.corps_name;

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="mb-2 space-y-3">
        <BackLink to="/fantasy" label="My leagues" />
        <div className="flex items-start gap-3">
          {viewer.isOwner ? (
            <LeagueImageUpload
              leagueId={league.leagueId}
              mediaId={league.imageMediaId}
              onChanged={refresh}
            />
          ) : league.imageMediaId ? (
            <img
              src={`/api/fantasy-media/${league.imageMediaId}`}
              alt=""
              className="size-12 shrink-0 rounded border border-border object-contain"
            />
          ) : null}
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-secondary">
              Fantasy Drum Corps · Season {league.season}
              {league.isTest ? (
                <Badge variant="warning-light" size="sm">
                  TEST
                </Badge>
              ) : null}
            </p>
            <LeagueNameHeading
              leagueId={league.leagueId}
              name={league.name}
              canEdit={viewer.isOwner}
              onRenamed={refresh}
            />
            <p className="text-sm text-text-secondary">
              {league.status} · {members.length}/{league.maxMembers} members
            </p>
          </div>
        </div>
        {STATUS_NARRATION[league.status] ? (
          <p className="text-sm text-muted-foreground">{STATUS_NARRATION[league.status]}</p>
        ) : null}
        <LeagueTabs
          slug={league.slug}
          active="home"
          isMember={viewer.isMember}
          quizEnabled={league.config.quiz.enabled}
        />
      </header>

      {viewer.isOwner ? (
        <LeagueSettings
          leagueId={league.leagueId}
          config={league.config}
          draftStarted={data.draft ? data.draft.status !== 'scheduled' : false}
          onSaved={refresh}
        />
      ) : null}

      {paymentsEnabled && viewer.isOwner ? (
        <PaymentPanel
          leagueId={league.leagueId}
          paymentStatus={league.paymentStatus}
          canRefund={['setup', 'quiz', 'scheduled'].includes(league.status)}
          onChanged={refresh}
        />
      ) : null}

      {viewer.isMember && data.pushEnabled ? <PushToggle /> : null}

      {viewer.isMember && me ? (
        <NotificationPrefs
          leagueId={league.leagueId}
          initialEmail={me.notify_email}
          initialPush={me.notify_push}
        />
      ) : null}

      {viewer.isOwner ? (
        <InvitePanel
          leagueId={league.leagueId}
          maxMembers={league.maxMembers}
          shareInvite={data.shareInvite}
          onChanged={refresh}
        />
      ) : null}

      {viewer.isMember && (needsIdentity || editing) ? (
        <Card>
          <CardHeader>
            <CardTitle>{needsIdentity ? 'Name your corps' : 'Edit your corps'}</CardTitle>
          </CardHeader>
          <CardContent>
            <CorpsIdentityForm
              leagueId={league.leagueId}
              initial={{
                corpsName: me?.corps_name,
                showTitle: me?.show_title,
                color: me?.corps_color,
                logoMediaId: me?.corps_logo_media_id,
              }}
              onSaved={() => {
                setEditing(false);
                void refresh();
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Members</h2>
        <ul className="flex flex-col gap-2">
          {members.map((m) => (
            <li key={m.user_id}>
              <MemberRow
                member={m}
                isViewer={m.user_id === viewer.userId}
                canEdit={m.user_id === viewer.userId && !needsIdentity}
                editing={editing}
                onToggleEdit={() => setEditing((v) => !v)}
              />
            </li>
          ))}
        </ul>
      </section>

      {viewer.isMember ? (
        <DangerZone
          leagueId={league.leagueId}
          isOwner={viewer.isOwner}
          status={league.status}
          onLeft={() => router.navigate({ to: '/fantasy' })}
          onCanceled={refresh}
        />
      ) : null}
    </PageShell>
  );
}

function DangerZone({
  leagueId,
  isOwner,
  status,
  onLeft,
  onCanceled,
}: {
  leagueId: string;
  isOwner: boolean;
  status: string;
  onLeft: () => Promise<void> | void;
  onCanceled: () => Promise<void> | void;
}) {
  if (status === 'canceled') {
    return <p className="text-sm text-muted-foreground">This league has been canceled.</p>;
  }

  return (
    <section className="flex flex-col items-start gap-2 border-t border-border pt-4">
      {isOwner ? (
        <ConfirmDialog
          trigger={
            <Button variant="destructive" size="sm">
              Cancel league
            </Button>
          }
          title="Cancel this league?"
          description="This ends the league for everyone and can't be undone."
          confirmLabel="Cancel league"
          destructive
          onConfirm={async () => {
            await cancelLeague({ data: { leagueId } });
            await onCanceled();
          }}
        />
      ) : (
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              Leave league
            </Button>
          }
          title="Leave this league?"
          description="You can rejoin from an invite link before the draft starts."
          confirmLabel="Leave league"
          destructive
          onConfirm={async () => {
            await leaveLeague({ data: { leagueId } });
            await onLeft();
          }}
        />
      )}
    </section>
  );
}

function LeagueImageUpload({
  leagueId,
  mediaId,
  onChanged,
}: {
  leagueId: string;
  mediaId: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const upload = useAsyncAction(
    async (file: File) => {
      const dataBase64 = await fileToBase64(file);
      const res = await uploadFantasyLogo({ data: { leagueId, dataBase64 } });
      await setLeagueImage({ data: { leagueId, mediaId: res.mediaId } });
      await onChanged();
    },
    (err) => `Image upload failed: ${err.message}`
  );
  return (
    <div className="flex flex-col gap-1">
      <PhotoUpload
        mediaId={mediaId}
        busy={upload.busy}
        onFile={(file) => upload.run(file)}
        alt="League image"
        variant="overlay"
        labels={{ empty: 'Add image', change: 'Change image' }}
      />
      {upload.error ? <span className="text-xs text-destructive">{upload.error}</span> : null}
    </div>
  );
}

function LeagueNameHeading({
  leagueId,
  name,
  canEdit,
  onRenamed,
}: {
  leagueId: string;
  name: string;
  canEdit: boolean;
  onRenamed: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const save = useAsyncAction(async () => {
    const next = draft.trim();
    if (next !== name) await renameLeague({ data: { leagueId, name: next } });
    setEditing(false);
    await onRenamed();
  });

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <h1 className="text-2xl font-bold text-text-primary">{name}</h1>
        {canEdit ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label="Rename league"
            title="Rename league"
            className="gap-1 text-text-secondary"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            <NoteEditIcon className="size-4" />
            <span className="hidden sm:inline">Rename</span>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim().length >= 2) void save.run();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="League name"
          className="max-w-xs text-lg font-semibold"
        />
        <BusyButton
          size="sm"
          busy={save.busy}
          disabled={draft.trim().length < 2}
          onClick={() => void save.run()}
        >
          Save
        </BusyButton>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {save.error ? <span className="text-sm text-destructive">{save.error}</span> : null}
    </div>
  );
}

function PaymentPanel({
  leagueId,
  paymentStatus,
  canRefund,
  onChanged,
}: {
  leagueId: string;
  paymentStatus: string;
  canRefund: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const pay = useAsyncAction(async () => {
    const res = await createLeagueCheckout({ data: { leagueId } });
    window.location.href = res.url;
  });
  const refund = useAsyncAction(async () => {
    await requestRefund({ data: { leagueId } });
    await onChanged();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {paymentStatus === 'paid' ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              League unlocked — payment received.
            </span>
            {canRefund ? (
              <BusyButton
                size="sm"
                variant="outline"
                busy={refund.busy}
                onClick={() => void refund.run()}
              >
                Request refund
              </BusyButton>
            ) : null}
          </div>
        ) : paymentStatus === 'refunded' ? (
          <span className="text-sm text-muted-foreground">
            Refunded — this league has been canceled.
          </span>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              Pay the one-time fee to unlock invites and the draft. Full refund any time before the
              draft starts.
            </p>
            <BusyButton size="sm" busy={pay.busy} onClick={() => void pay.run()}>
              Pay to unlock league
            </BusyButton>
          </div>
        )}
        {pay.error ? <p className="text-sm text-destructive">{pay.error}</p> : null}
        {refund.error ? <p className="text-sm text-destructive">{refund.error}</p> : null}
      </CardContent>
    </Card>
  );
}

function InvitePanel({
  leagueId,
  maxMembers,
  shareInvite,
  onChanged,
}: {
  leagueId: string;
  maxMembers: number;
  shareInvite: LeagueData['shareInvite'];
  onChanged: () => Promise<void> | void;
}) {
  const { copied, copy } = useCopyToClipboard();
  // Client-only capability detection — gate the Share button on navigator.share
  // after mount so SSR and first client render agree (no hydration mismatch).
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const mint = useAsyncAction(async () => {
    // A reusable link (many uses, longer-lived) — the league's default share link,
    // distinct from a one-shot emailed invite. Refresh so getLeague returns it and
    // the panel shows it by default from here on.
    await createInvite({ data: { leagueId, maxUses: 50, expiresInDays: 60 } });
    await onChanged();
  });

  const share = async (url: string) => {
    try {
      await navigator.share({ title: 'Join my fantasy drum corps league', url });
    } catch {
      copy(url); // cancelled or unsupported — fall back to copying
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite players</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Share this link to invite friends — anyone who opens it can join your league (up to{' '}
          {maxMembers} members). Each person can only join once.
        </p>
        {shareInvite ? (
          <>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareInvite.url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Invite link"
              />
              <Button size="sm" variant="outline" onClick={() => copy(shareInvite.url)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {canShare ? (
                <Button size="sm" onClick={() => void share(shareInvite.url)}>
                  Share
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {shareInvite.usedCount} of {shareInvite.maxUses} uses claimed.
            </p>
          </>
        ) : (
          <BusyButton
            className="self-start"
            size="sm"
            busy={mint.busy}
            onClick={() => void mint.run()}
          >
            Create shareable link
          </BusyButton>
        )}
        {mint.error ? <p className="text-sm text-destructive">{mint.error}</p> : null}
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  isViewer,
  canEdit,
  editing,
  onToggleEdit,
}: {
  member: Member;
  isViewer: boolean;
  canEdit: boolean;
  editing: boolean;
  onToggleEdit: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border p-3"
      style={
        member.corps_color ? { borderLeftColor: member.corps_color, borderLeftWidth: 4 } : undefined
      }
    >
      {member.corps_logo_media_id ? (
        <img
          src={`/api/fantasy-media/${member.corps_logo_media_id}`}
          alt=""
          className="size-9 rounded object-contain"
        />
      ) : (
        <div className="size-9 rounded bg-muted" />
      )}
      <div className="flex flex-col">
        <span className="font-medium">{member.corps_name || '(unnamed corps)'}</span>
        <span className="text-xs text-muted-foreground">
          {member.user_name ?? 'Player'}
          {member.role === 'owner' ? ' · owner' : ''}
          {member.show_title ? ` · ${member.show_title}` : ''}
        </span>
      </div>
      {isViewer && canEdit ? (
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onToggleEdit}>
          {editing ? 'Close' : 'Edit'}
        </Button>
      ) : null}
    </div>
  );
}
