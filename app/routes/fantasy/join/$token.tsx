import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { formatDraftDateTime } from '@/lib/fantasy/format-time';
import { getInvite, acceptInvite } from '@/lib/server-fns/fantasy';
import { refetchMyLeagues } from '@/db/fantasy-collections';
import { signIn, useSession } from '@/lib/auth-client';
import { useAsyncAction, matchMessage } from '@/lib/use-async-action';
import { BusyButton } from '@/components/fantasy/busy-button';
import { HowItWorks } from '@/components/fantasy/how-it-works';

const INVALID_MESSAGES: Record<string, string> = {
  invalid: 'This invite link is invalid, expired, or has been revoked.',
  used_up: 'This invite link has already been used up. Ask the league owner for a new one.',
  closed: 'This league is no longer accepting new members (the draft has started).',
};

export const Route = createFileRoute('/fantasy/join/$token')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => getInvite({ data: { token: params.token } }),
  head: () =>
    seoHead({
      title: 'Join a Fantasy League',
      description: 'Accept your fantasy drum corps league invite.',
      path: '/fantasy/join',
    }),
  component: JoinLeague,
});

function JoinLeague() {
  const invite = Route.useLoaderData();
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const { data: session } = useSession();

  const join = useAsyncAction(
    async () => {
      const res = await acceptInvite({ data: { token } });
      // The new membership should appear on /fantasy after joining.
      void refetchMyLeagues();
      await navigate({ to: '/fantasy/$slug', params: { slug: res.slug } });
    },
    (err) =>
      matchMessage(
        err,
        {
          full: 'This league is full.',
          'draft-started': 'The draft has already started — joining is closed.',
          'used-up': 'This invite link has already been used up.',
          'rate-limited': 'Too many attempts — wait a moment and try again.',
        },
        `Could not join: ${err.message}`
      )
  );

  if (invite.state !== 'ok') {
    return (
      <PageShell className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Invite</h1>
        <p className="text-muted-foreground">
          {INVALID_MESSAGES[invite.state] ?? INVALID_MESSAGES.invalid}
        </p>
      </PageShell>
    );
  }

  const { league } = invite;

  const continueWithGoogle = () => {
    // The token lives in the route path, and better-auth returns us to that exact
    // path via callbackURL — so it survives the OAuth round-trip with no cookie
    // (the plan's G.2 fallback cookie is unnecessary for a /$token route, and a
    // JS-readable invite cookie would be pure attack surface).
    void signIn.social({ provider: 'google', callbackURL: `/fantasy/join/${token}` });
  };

  return (
    <PageShell className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{league.name}</h1>
      <Card className="max-w-md">
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">
            You&apos;ve been invited to join this fantasy drum corps league ({league.memberCount}/
            {league.maxMembers} members). Here&apos;s what happens after you join:
          </p>
          {league.hostName || league.draftScheduledAt ? (
            <p className="text-sm text-muted-foreground">
              {league.hostName ? `Hosted by ${league.hostName}` : null}
              {league.hostName && league.draftScheduledAt ? ' · ' : ''}
              {league.draftScheduledAt
                ? `Draft ${formatDraftDateTime(league.draftScheduledAt)}`
                : null}
            </p>
          ) : null}
          <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
            <li>1. Name your corps — your team&apos;s identity.</li>
            <li>2. Take a quick drum corps quiz; your score sets your draft order.</li>
            <li>3. Draft real drum corps and compete on the standings.</li>
          </ol>

          {session?.user ? (
            <BusyButton busy={join.busy} onClick={() => void join.run()}>
              Join this league
            </BusyButton>
          ) : (
            <BusyButton onClick={continueWithGoogle}>Continue with Google to join</BusyButton>
          )}

          {join.error ? <p className="text-sm text-destructive">{join.error}</p> : null}
        </CardContent>
      </Card>

      {/* A cold invite link may be someone's first exposure — teach the concept. */}
      <HowItWorks className="max-w-md" />
    </PageShell>
  );
}
