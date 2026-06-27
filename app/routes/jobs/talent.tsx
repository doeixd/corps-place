import { createFileRoute, Link } from '@tanstack/react-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StaggeredGrid } from '@/components/staggered-grid';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { buildSeo } from '@/lib/seo';
import { searchTalent } from '@/lib/server-fns/jobs';
import { formatDistance } from '@/lib/geo';
import { useGeolocation } from '@/hooks/use-geolocation';
import { Search01Icon, UserMultipleIcon, Location01Icon } from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';

const PAGE_LIMIT = 50;

type SortKey = 'newest' | 'nearest';

export const Route = createFileRoute('/jobs/talent')({
  head: () =>
    buildSeo({
      title: 'Talent Search — PageantryJobs',
      description: 'Find pageantry industry professionals.',
      path: '/jobs/talent',
      noindex: true,
    }),
  loader: async () => searchTalent({ data: { offset: 0, limit: PAGE_LIMIT } }),
  component: TalentPage,
});

type TalentRow = Awaited<ReturnType<typeof searchTalent>>['rows'][number];

// Memoized so cards skip re-rendering on unrelated state (search input, etc.).
const TalentCard = memo(function TalentCard({ p }: { p: TalentRow }) {
  const d = p.distance_miles ?? null;
  return (
    <Link
      to="/jobs/profile/$slug"
      params={{ slug: p.slug }}
      className="block h-full focus-visible:outline-none"
    >
      <Card className="card-hover h-full">
        <CardContent className="flex h-full flex-col gap-3 py-4">
          <div className="flex items-center gap-3">
            {p.image_media_id ? (
              <img
                src={`/api/fantasy-media/${p.image_media_id}`}
                className="size-10 shrink-0 rounded-full border border-border object-cover"
                alt={p.display_name}
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {p.display_name.charAt(0)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-text-primary">{p.display_name}</p>
              {p.headline ? (
                <p className="truncate text-sm text-text-secondary">{p.headline}</p>
              ) : null}
            </div>
          </div>
          {p.location || d != null ? (
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
              {p.location ? (
                <span className="flex items-center gap-1">
                  <Icon icon={Location01Icon} size="xs" /> {p.location}
                </span>
              ) : null}
              {p.location && d != null ? <span>•</span> : null}
              {d != null ? <span>{formatDistance(d)}</span> : null}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
});

function TalentPage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();
  const [keyword, setKeyword] = useState('');
  const [nearZip, setNearZip] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [data, setData] = useState(initial ?? { rows: [], total: 0 });
  const [isPending, setIsPending] = useState(false);

  // "Nearest" works two ways: a typed Near-ZIP (geocoded server-side) or the
  // browser's geolocation (coords passed to the server). The server filters +
  // sorts + slices the FULL matching set, so paging stays correct.
  const geo = useGeolocation();
  const geoCoords = geo.state.status === 'located' ? geo.state.coords : null;
  // Ask for location when the user picks Nearest and hasn't typed a ZIP.
  useEffect(() => {
    if (sort === 'nearest' && !nearZip && geo.state.status === 'idle') geo.request();
  }, [sort, nearZip, geo]);

  const queryData = {
    keyword: keyword || undefined,
    sort,
    nearZip: nearZip || undefined,
    ...(sort === 'nearest' && !nearZip && geoCoords
      ? { nearLat: geoCoords.lat, nearLng: geoCoords.lng }
      : {}),
  };

  const runSearch = async (action: 'search' | 'more') => {
    setIsPending(true);
    const offset = action === 'more' ? data.rows.length : 0;
    const next = await searchTalent({ data: { ...queryData, offset, limit: PAGE_LIMIT } });
    setData((prev) =>
      action === 'more' ? { rows: [...prev.rows, ...next.rows], total: next.total } : next
    );
    setIsPending(false);
  };

  // Re-fetch (offset 0) when sort, ZIP, or geolocation (for Nearest) changes. The
  // keyword box drives its own explicit Search/Enter. `alive` drops stale responses.
  const geoLat = sort === 'nearest' && !nearZip ? (geoCoords?.lat ?? null) : null;
  const geoLng = sort === 'nearest' && !nearZip ? (geoCoords?.lng ?? null) : null;
  useEffect(() => {
    if (!session) return;
    let alive = true;
    setIsPending(true);
    searchTalent({ data: { ...queryData, offset: 0, limit: PAGE_LIMIT } }).then((next) => {
      if (!alive) return;
      setData(next);
      setIsPending(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, nearZip, geoLat, geoLng, session]);

  const rows = data.rows;
  const total = data.total;
  const hasMore = rows.length < total;
  const hasDistance = rows.some((p) => p.distance_miles != null);

  const sortItems = [
    { value: 'newest', label: 'Newest' },
    { value: 'nearest', label: 'Nearest' },
  ];

  const renderTalentCard = useCallback((p: TalentRow) => <TalentCard p={p} />, []);

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Talent Search" subtitle="Find pros across the marching arts" subtitleClassName="text-sm" backTo="/" backLabel="Home" />
        <JobsSignInGate icon={UserMultipleIcon} title="Search talent" path="/jobs/talent" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title="Talent Search" subtitle="Find pros across the marching arts" subtitleClassName="text-sm" backTo="/" backLabel="Home" />

      <form
        action={() => runSearch('search')}
        className="mt-4 flex flex-col gap-2 sm:flex-row"
      >
        <div className="relative w-full sm:flex-1">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch('search')}
            placeholder="Search talent by name or skill…"
            className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <div className="relative w-full sm:w-44">
          <Icon
            icon={Location01Icon}
            size="sm"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={nearZip}
            onChange={(e) => setNearZip(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch('search')}
            inputMode="numeric"
            maxLength={5}
            placeholder="Near ZIP"
            className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <Button type="submit" disabled={isPending} variant="outline" className="h-11 px-4">
          <Icon icon={Search01Icon} size="sm" /> {isPending ? '…' : 'Search'}
        </Button>
      </form>

      {rows.length === 0 ? (
        <Card className="mt-4">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={Search01Icon} size="xl" className="text-text-muted" />
            <p className="text-lg font-medium text-text-primary">No talent found</p>
            <p className="max-w-sm text-sm text-text-secondary">
              No published employee profiles match your criteria yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">
              {total} professional{total !== 1 ? 's' : ''} found
              {sort === 'nearest' ? (
                hasDistance || geoCoords ? (
                  <span className="ml-1 text-text-secondary">· Nearest first</span>
                ) : geo.state.status === 'locating' ? (
                  <span className="ml-1 text-text-secondary">· Locating…</span>
                ) : geo.state.status === 'denied' ||
                  geo.state.status === 'unsupported' ||
                  geo.state.status === 'error' ? (
                  <span className="ml-1 text-text-secondary">
                    · Enter a ZIP above to sort by distance
                  </span>
                ) : null
              ) : null}
            </p>
            <ToggleGroup
              value={[sort]}
              onValueChange={(v) => setSort((v[0] as SortKey) ?? 'newest')}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Sort talent"
            >
              {sortItems.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <StaggeredGrid
            items={rows}
            getKey={(p) => p.profile_id}
            renderItem={renderTalentCard}
            gap="gap-4"
            animationKey={`${keyword}|${nearZip}|${sort}`}
          />

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={() => runSearch('more')} disabled={isPending} variant="outline" size="sm">
                {isPending ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
