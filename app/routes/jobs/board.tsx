import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { FilterChips } from '@/components/filter-chips';
import { StaggeredGrid } from '@/components/staggered-grid';
import { SectionErrorBoundary } from '@/components/error-boundary';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { seoHead, breadcrumbLd } from '@/lib/seo';
import { listJobs, bookmarkJob, removeBookmark, getMyBookmarks } from '@/lib/server-fns/jobs';
import { DISCIPLINES } from '@/lib/jobs/disciplines';
import { JobCard, type JobRow } from '@/components/jobs/job-card';
import { useGeolocation } from '@/hooks/use-geolocation';
import { useSession } from '@/lib/auth-client';
import { Search01Icon, Location01Icon } from '@/components/icons/generated';

const PAGE_LIMIT = 50;

type WorkType = 'remote' | 'onsite';
type SortKey = 'nearest' | 'pay';

type JobsSearch = { q?: string; work?: WorkType; sort?: SortKey; discipline?: string };

const DISCIPLINE_VALUES = DISCIPLINES.map((d) => d.value) as readonly string[];

const WORK_FILTERS = [
  { value: '', label: 'All' },
  { value: 'remote', label: 'Remote' },
  { value: 'onsite', label: 'On-site' },
] as const;

export const Route = createFileRoute('/jobs/board')({
  head: () =>
    seoHead({
      title: 'Job Board — PageantryJobs',
      description:
        'Browse pageantry industry jobs — drum corps, marching band, winter guard, and indoor percussion.',
      path: '/jobs/board',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Job Board', path: '/jobs/board' },
        ]),
      ],
    }),
  // Filters/sort live in the query string so a filtered view is shareable/bookmarkable.
  validateSearch: (search: Record<string, unknown>): JobsSearch => {
    const out: JobsSearch = {};
    if (typeof search.q === 'string' && search.q.trim()) out.q = search.q.trim();
    if (search.work === 'remote' || search.work === 'onsite') out.work = search.work;
    if (search.sort === 'nearest' || search.sort === 'pay') out.sort = search.sort;
    if (typeof search.discipline === 'string' && DISCIPLINE_VALUES.includes(search.discipline))
      out.discipline = search.discipline;
    return out;
  },
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => listJobs({ data: { keyword: deps.q, offset: 0, limit: PAGE_LIMIT } }),
  component: BoardPage,
});

function BoardPage() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [keyword, setKeyword] = useState(search.q ?? '');
  const [nearZip, setNearZip] = useState('');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  // Saved-jobs state: fetched once for the whole board (not per card) and toggled
  // optimistically so the heart responds instantly.
  const { data: session } = useSession();
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!session) return;
    let alive = true;
    void getMyBookmarks()
      .then((bm) => {
        if (alive) setSavedIds(new Set(bm.map((b) => b.posting_id)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session]);

  const onToggleSave = useCallback(
    (postingId: string) => {
      if (!session) {
        toast.error('Sign in to save jobs');
        return;
      }
      setSavedIds((prev) => {
        const wasSaved = prev.has(postingId);
        const next = new Set(prev);
        if (wasSaved) next.delete(postingId);
        else next.add(postingId);
        // Revert the optimistic toggle if the server write fails, so the heart
        // can't silently diverge from the persisted state.
        const op = wasSaved ? removeBookmark : bookmarkJob;
        void op({ data: { postingId } }).catch(() => {
          setSavedIds((p) => {
            const reverted = new Set(p);
            if (wasSaved) reverted.add(postingId);
            else reverted.delete(postingId);
            return reverted;
          });
          toast.error('Could not update saved jobs');
        });
        return next;
      });
    },
    [session]
  );

  const work = search.work;
  const sort = search.sort;
  const discipline = search.discipline;

  // "Nearest" works two ways: a typed Near-ZIP (geocoded server-side) or the
  // browser's geolocation (coords passed to the server). Either way the server
  // filters + sorts + slices the FULL matching set, so paging stays correct.
  const geo = useGeolocation();
  const geoCoords = geo.state.status === 'located' ? geo.state.coords : null;
  // Ask for location when the user picks Nearest and hasn't typed a ZIP.
  useEffect(() => {
    if (sort === 'nearest' && !nearZip && geo.state.status === 'idle') geo.request();
  }, [sort, nearZip, geo]);

  // The server query params derived from the current keyword/filter/sort/origin.
  // `nearLat`/`nearLng` ride along only for geolocation-driven nearest (no ZIP).
  const queryData = {
    keyword: keyword || undefined,
    work,
    discipline,
    sort: (sort ?? 'newest') as 'newest' | 'nearest' | 'pay',
    nearZip: nearZip || undefined,
    ...(sort === 'nearest' && !nearZip && geoCoords
      ? { nearLat: geoCoords.lat, nearLng: geoCoords.lng }
      : {}),
  };

  const doSearch = async () => {
    setLoading(true);
    const results = await listJobs({ data: { ...queryData, offset: 0, limit: PAGE_LIMIT } });
    setData(results);
    setLoading(false);
  };

  const loadMore = async () => {
    setLoading(true);
    const next = await listJobs({
      data: { ...queryData, offset: data.rows.length, limit: PAGE_LIMIT },
    });
    setData((prev) => ({ rows: [...prev.rows, ...next.rows], total: next.total }));
    setLoading(false);
  };

  // Re-fetch (offset 0) whenever a server-affecting input changes: the work
  // filter, the sort, the typed ZIP, or geolocation resolving while Nearest is
  // selected. The keyword box drives its own explicit Search/Enter, so it is not
  // a dependency here. An `alive` guard drops stale responses.
  const geoLat = sort === 'nearest' && !nearZip ? (geoCoords?.lat ?? null) : null;
  const geoLng = sort === 'nearest' && !nearZip ? (geoCoords?.lng ?? null) : null;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    listJobs({ data: { ...queryData, offset: 0, limit: PAGE_LIMIT } }).then((results) => {
      if (!alive) return;
      setData(results);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, sort, discipline, nearZip, geoLat, geoLng]);

  const setWork = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, work: value === 'remote' || value === 'onsite' ? value : undefined }),
      replace: true,
      resetScroll: false,
    });
  const setSort = (value: string | null) =>
    void navigate({
      search: (prev) => ({ ...prev, sort: value === 'nearest' || value === 'pay' ? value : undefined }),
      replace: true,
      resetScroll: false,
    });
  const setDiscipline = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, discipline: DISCIPLINE_VALUES.includes(value) ? value : undefined }),
      replace: true,
      resetScroll: false,
    });

  const rows = data.rows;
  const total = data.total;
  const hasMore = rows.length < total;
  const hasDistance = rows.some((j) => j.distance_miles != null);

  const sortItems = [
    { value: 'newest', label: 'Newest' },
    { value: 'nearest', label: 'Nearest' },
    { value: 'pay', label: 'Pay' },
  ];
  const sortValue = sort ?? 'newest';

  // Stable identity + memoized cards: cards skip re-rendering on unrelated state
  // (e.g. typing in the search box) as long as their row object is unchanged.
  const renderJobCard = useCallback(
    (job: JobRow) => (
      <JobCard job={job} saved={savedIds.has(job.posting_id)} onToggleSave={onToggleSave} />
    ),
    [savedIds, onToggleSave]
  );

  return (
    <PageShell>
      <PageHeader title="Job Board" subtitle="Pageantry & marching-arts job listings" subtitleClassName="text-sm" backTo="/" backLabel="Home" />

      <Link
        to="/jobs/categories"
        className="mt-1 inline-block text-sm font-medium text-primary hover:underline"
      >
        Browse jobs by discipline &amp; role →
      </Link>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative w-full sm:flex-1">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="Search jobs by keyword…"
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
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            inputMode="numeric"
            maxLength={5}
            placeholder="Near ZIP"
            className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <Button onClick={doSearch} disabled={loading} variant="outline" className="h-11 px-4">
          <Icon icon={Search01Icon} size="sm" /> {loading ? '…' : 'Search'}
        </Button>
      </div>

      {rows.length === 0 && !loading ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={Search01Icon} size="xl" className="text-text-muted" />
            <p className="text-lg font-medium text-text-primary">No jobs posted yet</p>
            <p className="max-w-sm text-sm text-text-secondary">
              Be the first to post a job and find great talent in the pageantry community.
            </p>
            <Link
              to="/jobs/post"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              Post a job
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <FilterChips
                items={WORK_FILTERS}
                value={work ?? ''}
                onSelect={setWork}
                ariaLabel="Filter by work type"
              />
              <select
                value={discipline ?? ''}
                onChange={(e) => setDiscipline(e.target.value)}
                aria-label="Filter by discipline"
                className="h-8 rounded-md border border-border bg-card px-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              >
                <option value="">All disciplines</option>
                {DISCIPLINES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <ToggleGroup
              value={[sortValue]}
              onValueChange={(v) => setSort((v[0] as string | undefined) ?? null)}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Sort jobs"
            >
              {sortItems.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <p className="text-sm text-text-muted">
            {total} job{total !== 1 ? 's' : ''}
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

          <SectionErrorBoundary label="the job results">
            <StaggeredGrid
              items={rows}
              getKey={(j) => j.posting_id}
              renderItem={renderJobCard}
              gap="gap-4"
              animationKey={`${search.q ?? ''}|${work ?? ''}|${discipline ?? ''}|${sort ?? ''}|${nearZip}`}
            />
          </SectionErrorBoundary>

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={loadMore} disabled={loading} variant="outline" size="sm">
                {loading ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
