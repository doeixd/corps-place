import { createFileRoute, Link } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { listMyLeagues } from '@/lib/server-fns/fantasy';
import { SignInButton } from '@/components/sign-in-button';
import { HowItWorks } from '@/components/fantasy/how-it-works';
import { StaticLeagueList } from '@/components/fantasy/league-list-item';

// The live league list pulls the TanStack DB collection layer (~190KB with its
// HybridCollection wrapper) and the better-auth client. Load it lazily so
// logged-out visitors — and signed-in users with no leagues — never download it;
// /fantasy is then just the marketing + sign-in shell for them. Signed-in users
// with leagues get the SSR'd static list immediately (the Suspense fallback,
// straight from loader data) while the live version streams in.
const MyLeaguesList = lazy(() => import('@/components/fantasy/my-leagues-list'));

export const Route = createFileRoute('/fantasy/')({
  beforeLoad: requireFantasyEnabled,
  loader: async () => {
    const { signedIn, leagues } = await listMyLeagues();
    return { signedIn, leagues };
  },
  // Leagues barely change mid-session and the live collection picks up changes
  // anyway; a short staleTime keeps tab-hopping navs off the network.
  staleTime: 60_000,
  head: () =>
    seoHead({
      title: 'Fantasy Drum Corps — My Leagues',
      description: 'Your fantasy drum corps leagues.',
      path: '/fantasy',
    }),
  component: FantasyHome,
});

function FantasyHome() {
  // `signedIn` comes from the loader (a real server-side session check), so it's
  // authoritative — no client useSession() needed here (which would pull the
  // better-auth client onto this route for logged-out visitors too). A sign-in
  // flow does a full redirect, so the loader re-runs and this updates.
  const { signedIn, leagues } = Route.useLoaderData();

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3 pr-12 lg:pr-0">
        <h1 className="text-2xl font-bold text-text-primary">Fantasy Drum Corps</h1>
        {signedIn ? (
          <Button render={<Link to="/fantasy/create" />}>Create a league</Button>
        ) : (
          <SignInButton callbackURL="/fantasy">Sign in to play</SignInButton>
        )}
      </div>

      {!signedIn ? (
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
        // Only signed-in users who actually have leagues pay for the collection
        // layer. The static list (from loader data) SSRs + fills the fallback so
        // the leagues show instantly; the live collection swaps in once loaded.
        <Suspense fallback={<StaticLeagueList leagues={leagues} />}>
          <MyLeaguesList leagues={leagues} />
        </Suspense>
      )}
    </PageShell>
  );
}
