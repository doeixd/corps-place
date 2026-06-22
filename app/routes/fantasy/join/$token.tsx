import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getInvite, acceptInvite } from '@/lib/server-fns/fantasy';
import { signIn, useSession } from '@/lib/auth-client';
import { useAsyncAction, matchMessage } from '@/lib/use-async-action';

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
      await navigate({ to: '/fantasy/$slug', params: { slug: res.slug } });
    },
    (err) =>
      matchMessage(
        err,
        {
          full: 'This league is full.',
          'draft-started': 'The draft has already started — joining is closed.',
          'used-up': 'This invite link has already been used up.',
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
    // Belt-and-suspenders fallback if the path token is lost across the OAuth
    // round-trip; the callbackURL already returns us to this exact route (G.2).
    document.cookie = `fantasy_invite=${token}; Path=/; Max-Age=1800; SameSite=Lax`;
    void signIn.social({ provider: 'google', callbackURL: `/fantasy/join/${token}` });
  };

  return (
    <PageShell className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{league.name}</h1>
      <p className="text-muted-foreground">
        You've been invited to join this fantasy drum corps league ({league.memberCount}/
        {league.maxMembers} members).
      </p>

      {session?.user ? (
        <Button className="self-start" onClick={() => void join.run()} disabled={join.busy}>
          {join.busy ? 'Joining…' : 'Join this league'}
        </Button>
      ) : (
        <Button className="self-start" onClick={continueWithGoogle}>
          Continue with Google to join
        </Button>
      )}

      {join.error ? <p className="text-sm text-destructive">{join.error}</p> : null}
    </PageShell>
  );
}
