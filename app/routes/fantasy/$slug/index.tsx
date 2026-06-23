import { useState } from 'react';
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
} from '@/lib/server-fns/fantasy';
import { CorpsIdentityForm } from '@/components/fantasy/corps-identity-form';
import { PushToggle } from '@/components/fantasy/push-toggle';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard';

type LeagueData = Awaited<ReturnType<typeof getLeague>>;
type Member = LeagueData['members'][number];

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
  const { league, members, viewer, paymentsEnabled } = Route.useLoaderData();
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  const me = members.find((m) => m.user_id === viewer.userId);
  const needsIdentity = viewer.isMember && !me?.corps_name;

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{league.name}</h1>
        <p className="text-sm text-muted-foreground">
          Season {league.season} · {league.status} · {members.length}/{league.maxMembers} members
        </p>
        <nav className="flex flex-wrap gap-4 text-sm">
          {viewer.isMember && league.config.quiz.enabled ? (
            <Link
              to="/fantasy/$slug/quiz"
              params={{ slug: league.slug }}
              className="text-primary hover:underline"
            >
              Take the knowledge quiz →
            </Link>
          ) : null}
          {viewer.isMember ? (
            <Link
              to="/fantasy/$slug/draft"
              params={{ slug: league.slug }}
              className="text-primary hover:underline"
            >
              Draft room →
            </Link>
          ) : null}
          <Link
            to="/fantasy/$slug/standings"
            params={{ slug: league.slug }}
            className="text-primary hover:underline"
          >
            Standings →
          </Link>
        </nav>
      </header>

      {paymentsEnabled && viewer.isOwner ? (
        <PaymentPanel
          leagueId={league.leagueId}
          paymentStatus={league.paymentStatus}
          canRefund={['setup', 'quiz', 'scheduled'].includes(league.status)}
        />
      ) : null}

      {viewer.isMember ? <PushToggle /> : null}

      {viewer.isOwner ? <InvitePanel leagueId={league.leagueId} /> : null}

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
                void router.invalidate();
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

function PaymentPanel({
  leagueId,
  paymentStatus,
  canRefund,
}: {
  leagueId: string;
  paymentStatus: string;
  canRefund: boolean;
}) {
  const router = useRouter();
  const pay = useAsyncAction(async () => {
    const res = await createLeagueCheckout({ data: { leagueId } });
    window.location.href = res.url;
  });
  const refund = useAsyncAction(async () => {
    await requestRefund({ data: { leagueId } });
    await router.invalidate();
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

function InvitePanel({ leagueId }: { leagueId: string }) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const mint = useAsyncAction(async () => {
    const res = await createInvite({ data: { leagueId } });
    setInviteUrl(res.url);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite players</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <BusyButton
          className="self-start"
          size="sm"
          busy={mint.busy}
          onClick={() => void mint.run()}
        >
          Create invite link
        </BusyButton>
        {mint.error ? <p className="text-sm text-destructive">{mint.error}</p> : null}
        {inviteUrl ? (
          <div className="flex items-center gap-2">
            <Input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" variant="outline" onClick={() => copy(inviteUrl)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        ) : null}
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
