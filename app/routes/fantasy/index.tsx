import { createFileRoute, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { listMyLeagues } from '@/lib/server-fns/fantasy';
import { leaguesCollection } from '@/db/fantasy-collections';
import { HybridCollection } from '@/components/hybrid-collection';
import { useSession } from '@/lib/auth-client';
import { SignInButton } from '@/components/sign-in-button';
import { HowItWorks } from '@/components/fantasy/how-it-works';

type LeagueRow = Awaited<ReturnType<typeof listMyLeagues>>['leagues'][number];

export const Route = createFileRoute('/fantasy/')({
  beforeLoad: requireFantasyEnabled,
  loader: async () => {
    try {
      const { leagues } = await listMyLeagues();
      return { signedIn: true, leagues };
    } catch (e) {
      if ((e as Error).message.includes('UNAUTHENTICATED')) {
        return { signedIn: false, leagues: [] as LeagueRow[] };
      }
      throw e;
    }
  },
  head: () =>
    seoHead({
      title: 'Fantasy Drum Corps — My Leagues',
      description: 'Your fantasy drum corps leagues.',
      path: '/fantasy',
    }),
  component: FantasyHome,
});

function FantasyHome() {
  const { signedIn, leagues } = Route.useLoaderData();
  // SSR + first paint render from the loader; after hydration the live
  // collection drives the list (e.g. picks up a league created in another tab).
  return (
    <HybridCollection collection={leaguesCollection} loader={leagues}>
      {(rows) => <FantasyHomeContent signedIn={signedIn} leagues={rows} />}
    </HybridCollection>
  );
}

function FantasyHomeContent({ signedIn, leagues }: { signedIn: boolean; leagues: LeagueRow[] }) {
  const { data: session } = useSession();
  const isSignedIn = signedIn || Boolean(session?.user);

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3 pr-12 lg:pr-0">
        <h1 className="text-2xl font-bold text-text-primary">Fantasy Drum Corps</h1>
        {isSignedIn ? (
          <Button render={<Link to="/fantasy/create" />}>Create a league</Button>
        ) : (
          <SignInButton callbackURL="/fantasy">Sign in to play</SignInButton>
        )}
      </div>

      {!isSignedIn ? (
        <>
          <p className="text-muted-foreground">
            Sign in to create a private league, draft real drum corps, and compete on standings
            computed from real recaps.
          </p>
          <HowItWorks />
        </>
      ) : leagues.length === 0 ? (
        <>
          <p className="text-muted-foreground">
            You&apos;re not in any leagues yet — create one, or ask a friend to invite you to
            theirs.
          </p>
          <HowItWorks />
        </>
      ) : (
        <ul className="flex flex-col gap-2">
          {leagues.map((l) => (
            <li key={l.league_id}>
              <LeagueListItem league={l} />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

function LeagueListItem({ league }: { league: LeagueRow }) {
  return (
    <Link
      to="/fantasy/$slug"
      params={{ slug: league.slug }}
      className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-muted"
    >
      {league.image_media_id ? (
        <img
          src={`/api/fantasy-media/${league.image_media_id}`}
          alt=""
          className="size-10 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : null}
      <span className="font-medium">{league.name}</span>
      <span className="ml-auto text-sm text-muted-foreground">
        {league.season} · {league.status}
        {league.role === 'owner' ? ' · owner' : ''}
      </span>
    </Link>
  );
}
