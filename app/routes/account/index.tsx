import { createFileRoute, Link } from '@tanstack/react-router';
import { getMyAccountOverview } from '@/lib/server-fns/account';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { useFavoriteCorps } from '@/stores/favorite-corps-store';
import { useBookmarks } from '@/stores/bookmark-store';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/')({
  // Always fresh — account data must never be served from a stale router cache.
  loader: async () => getMyAccountOverview(),
  staleTime: 0,
  head: () => buildSeo({ title: 'Your account',
      description: 'Your leagues, ballots, bookmarks and settings.', path: '/account', noindex: true }),
  component: AccountOverview,
});

function Tile({
  to,
  label,
  value,
  hint,
}: {
  to: string;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Link to={to} className="block focus-visible:outline-none">
      <Card className="card-hover h-full">
        <CardContent className="py-4">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-sm font-medium">{label}</div>
          {hint ? <div className="text-xs text-text-muted">{hint}</div> : null}
        </CardContent>
      </Card>
    </Link>
  );
}

function AccountOverview() {
  const overview = Route.useLoaderData();
  const favorite = useFavoriteCorps();
  const bookmarks = useBookmarks();

  if (!overview.signedIn || !overview.identity) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account" />
      </AccountShell>
    );
  }
  const id = overview.identity;
  const memberSince = id.createdAt
    ? new Date(id.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    : null;

  return (
    <AccountShell>
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-4 py-5">
            {id.image ? (
              <img
                src={id.image}
                alt=""
                referrerPolicy="no-referrer"
                className="size-14 rounded-full border border-border"
              />
            ) : (
              <div className="flex size-14 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                {id.name.slice(0, 1).toUpperCase() || '?'}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-lg font-semibold">{id.name}</span>
                {id.role !== 'user' ? (
                  <Badge variant="outline" radius="full">
                    {id.role}
                  </Badge>
                ) : null}
              </div>
              <div className="truncate text-sm text-text-secondary">{id.email}</div>
              {memberSince ? (
                <div className="text-xs text-text-muted">Member since {memberSince}</div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile to="/account/leagues" label="Fantasy leagues" value={overview.counts.leagues} />
          <Tile to="/account/ballots" label="Prediction ballots" value={overview.counts.ballots} />
          <Tile
            to="/account/bookmarks"
            label="Bookmarked products"
            value={bookmarks.length}
            hint="This device"
          />
          <Tile
            to="/account/notifications"
            label="Score alerts"
            value={overview.counts.scoreSubscriptions}
            hint="Email & push subscriptions"
          />
        </div>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <div className="text-sm font-medium">Favorite corps</div>
              <div className="text-sm text-text-secondary">
                {favorite ? favorite.name : 'None yet — tap the heart on any corps page.'}
              </div>
              <div className="text-xs text-text-muted">
                Saved on this device; it themes the whole site.
              </div>
            </div>
            {favorite?.slug ? (
              <Link
                to="/corps/$slug/{-$season}"
                params={{ slug: favorite.slug }}
                className="text-sm text-primary hover:underline"
              >
                View corps
              </Link>
            ) : (
              <Link to="/corps" className="text-sm text-primary hover:underline">
                Browse corps
              </Link>
            )}
          </CardContent>
        </Card>

        {overview.counts.contributions > 0 ? (
          <Card>
            <CardContent className="py-4 text-sm text-text-secondary">
              You&rsquo;ve made{' '}
              <span className="font-semibold text-text-primary">
                {overview.counts.contributions}
              </span>{' '}
              wiki contribution{overview.counts.contributions === 1 ? '' : 's'} — thank you!{' '}
              <Link to="/account/contributions" className="text-primary hover:underline">
                See your history
              </Link>
              .
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AccountShell>
  );
}
