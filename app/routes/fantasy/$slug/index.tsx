import { useState, useEffect } from 'react';
import { createFileRoute, notFound, useRouter, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
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
} from '@/lib/server-fns/fantasy';
import { CorpsIdentityForm } from '@/components/fantasy/corps-identity-form';
import { PushToggle } from '@/components/fantasy/push-toggle';
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
    'Season underway — scores update automatically from real DCI results as competitions are recapped. Watch the standings.',
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
      title: loaderData ? `${loaderData.league.name} — Fantasy DCI` : 'Fantasy DCI',
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
      <header className="flex flex-col gap-2">
        <LeagueNameHeading
          leagueId={league.leagueId}
          name={league.name}
          canEdit={viewer.isOwner}
          onRenamed={refresh}
        />
        <p className="text-sm text-muted-foreground">
          Season {league.season} · {league.status} · {members.length}/{league.maxMembers} members
        </p>
        {STATUS_NARRATION[league.status] ? (
          <p className="text-sm text-muted-foreground">{STATUS_NARRATION[league.status]}</p>
        ) : null}
        <nav className="flex flex-wrap gap-2">
          {viewer.isMember && league.config.quiz.enabled ? (
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/fantasy/$slug/quiz" params={{ slug: league.slug }} />}
            >
              Quiz
            </Button>
          ) : null}
          {viewer.isMember ? (
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/fantasy/$slug/draft" params={{ slug: league.slug }} />}
            >
              Draft room
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/fantasy/$slug/standings" params={{ slug: league.slug }} />}
          >
            Standings
          </Button>
        </nav>
      </header>

      {paymentsEnabled && viewer.isOwner ? (
        <PaymentPanel
          leagueId={league.leagueId}
          paymentStatus={league.paymentStatus}
          canRefund={['setup', 'quiz', 'scheduled'].includes(league.status)}
          onChanged={refresh}
        />
      ) : null}

      {viewer.isMember && data.pushEnabled ? <PushToggle /> : null}

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
    </PageShell>
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
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold">{name}</h1>
        {canEdit ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            Rename
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
      await navigator.share({ title: 'Join my Fantasy DCI league', url });
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
