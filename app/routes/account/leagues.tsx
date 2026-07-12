import { createFileRoute, Link } from '@tanstack/react-router';
import { listMyLeagues } from '@/lib/server-fns/fantasy';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/leagues')({
  loader: async () => listMyLeagues(),
  staleTime: 0,
  head: () => buildSeo({ title: 'Your leagues',
      description: 'Fantasy leagues you belong to.', path: '/account/leagues', noindex: true }),
  component: AccountLeagues,
});

function AccountLeagues() {
  const { signedIn, leagues } = Route.useLoaderData();

  if (!signedIn) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/leagues" />
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Fantasy leagues</h2>
          <Link to="/fantasy" className="text-sm text-primary hover:underline">
            Fantasy home
          </Link>
        </div>
        {leagues.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-text-secondary">
              You&rsquo;re not in any leagues yet.{' '}
              <Link to="/fantasy" className="text-primary hover:underline">
                Create or join one
              </Link>{' '}
              to draft your corps.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {leagues.map((l) => (
              <Link
                key={l.league_id}
                to="/fantasy/$slug"
                params={{ slug: l.slug }}
                className="block focus-visible:outline-none"
              >
                <Card className="card-hover h-full">
                  <CardContent className="space-y-1 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{l.name}</span>
                      {l.role === 'owner' ? (
                        <Badge variant="outline" radius="full">
                          Owner
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-sm text-text-secondary">
                      {l.season} season · {l.status}
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
