import { createFileRoute, Link } from '@tanstack/react-router';
import { myBallots } from '@/lib/server-fns/ballot';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { getMyAccountOverview } from '@/lib/server-fns/account';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/ballots')({
  // myBallots returns [] for anonymous users, which is indistinguishable from
  // "signed in, none yet" — fetch the overview's signedIn flag alongside.
  loader: async () => {
    const [ballots, overview] = await Promise.all([myBallots(), getMyAccountOverview()]);
    return { ballots, signedIn: overview.signedIn };
  },
  staleTime: 0,
  head: () => buildSeo({ title: 'Your ballots',
      description: 'Prediction ballots you have locked.', path: '/account/ballots', noindex: true }),
  component: AccountBallots,
});

function AccountBallots() {
  const { ballots, signedIn } = Route.useLoaderData();

  if (!signedIn) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/ballots" />
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Prediction ballots</h2>
          <Link to="/predict/finals" className="text-sm text-primary hover:underline">
            Make a prediction
          </Link>
        </div>
        {ballots.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-text-secondary">
              No locked ballots yet.{' '}
              <Link to="/predict/finals" className="text-primary hover:underline">
                Predict the finals order
              </Link>{' '}
              and lock it in before the show.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {ballots.map((b) => (
              <Link
                key={b.ballotId}
                // /predict/ballot/$id is only a legacy redirect to finals/$id —
                // link the canonical route directly.
                to="/predict/finals/$id"
                params={{ id: b.ballotId }}
                className="block focus-visible:outline-none"
              >
                <Card className="card-hover h-full">
                  <CardContent className="space-y-1 py-4">
                    <div className="font-semibold">{b.title ?? `${b.season} ${b.preset}`}</div>
                    <div className="text-sm text-text-secondary">
                      {b.season} · locked{' '}
                      {new Date(b.lockedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AccountShell>
  );
}
