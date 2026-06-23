import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getStaffDirectory } from '@/lib/server-fns/hybrid';
import { staffCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import type { StaffSummary } from '@/lib/staff-directory';
import { ProgressiveImage } from '@/components/progressive-image';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { seoHead, breadcrumbLd } from '@/lib/seo';

type StaffSearch = { q?: string; s?: number };

export const Route = createFileRoute('/staff/')({
  validateSearch: (search: Record<string, unknown>): StaffSearch => {
    const out: StaffSearch = {};
    if (typeof search.q === 'string' && search.q) out.q = search.q;
    if (typeof search.s === 'number' && search.s > 0) out.s = search.s;
    return out;
  },
  loader: async () => ({ staff: await getStaffDirectory() }),
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    const n = d.staff.length;
    return seoHead({
      title: 'Drum Corps Staff & Instructors Directory',
      description: `Browse ${n} drum corps instructors, designers and directors — the people who teach DCI corps, with roles, corps history and bios on DrumCorps.app.`,
      path: '/staff',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Staff', path: '/staff' },
        ]),
      ],
    });
  },
  staleTime: 60_000,
  component: StaffDirectory,
});

function StaffDirectory() {
  const { staff } = Route.useLoaderData();
  return (
    <HybridCollection collection={staffCollection} loader={staff}>
      {(rows) => <StaffDirectoryContent staff={rows as unknown as StaffSummary[]} />}
    </HybridCollection>
  );
}

const CARD_HEIGHT = 76;
const GAP = 12;
const ROW_HEIGHT = CARD_HEIGHT + GAP;
const SCROLL_WRITE_DEBOUNCE_MS = 250;
const SCROLL_WRITE_EPSILON = 16;

const getStaffColumnSnapshot = () => {
  if (typeof window === 'undefined') return 3;
  if (window.matchMedia('(min-width: 1024px)').matches) return 3;
  if (window.matchMedia('(min-width: 640px)').matches) return 2;
  return 1;
};

const subscribeStaffColumns = (onStoreChange: () => void) => {
  if (typeof window === 'undefined') return () => {};

  const queries = ['(min-width: 640px)', '(min-width: 1024px)'].map((query) =>
    window.matchMedia(query)
  );
  queries.forEach((query) => query.addEventListener('change', onStoreChange));

  return () => {
    queries.forEach((query) => query.removeEventListener('change', onStoreChange));
  };
};

function useStaffColumns() {
  return useSyncExternalStore(subscribeStaffColumns, getStaffColumnSnapshot, () => 3);
}

function StaffDirectoryContent({ staff }: { staff: StaffSummary[] }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const columns = useStaffColumns();
  const latestSearchRef = useRef(search);
  const didRestoreScrollRef = useRef(false);
  latestSearchRef.current = search;

  const query = search.q ?? '';
  const setQuery = (q: string) =>
    void navigate({
      search: (prev) => ({ ...prev, q: q || undefined, s: undefined }),
      replace: true,
      resetScroll: false,
    });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(
      (s) =>
        s.display_name.toLowerCase().includes(q) ||
        (s.default_title ?? '').toLowerCase().includes(q) ||
        (s.groups ?? []).some((g) => g.corps_name.toLowerCase().includes(q))
    );
  }, [staff, query]);

  const virtualizer = useWindowVirtualizer({
    count: Math.ceil(rows.length / columns),
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    gap: GAP,
  });

  // Restore the browser viewport from the URL once; later scroll writes should not replay it.
  useEffect(() => {
    if (didRestoreScrollRef.current) return;
    didRestoreScrollRef.current = true;

    const scrollY = typeof search.s === 'number' ? search.s : 0;
    if (scrollY > 0) {
      const frame = requestAnimationFrame(() => window.scrollTo(0, scrollY));
      return () => cancelAnimationFrame(frame);
    }
  }, [search.s]);

  // Save scroll position to URL on scroll end without letting the router reset the viewport.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const scrollY = Math.round(window.scrollY);
        const currentScrollY = latestSearchRef.current.s ?? 0;
        if (Math.abs(currentScrollY - scrollY) < SCROLL_WRITE_EPSILON) return;

        void navigate({
          search: (prev) => ({ ...prev, s: scrollY > 0 ? scrollY : undefined }),
          replace: true,
          resetScroll: false,
        });
      }, SCROLL_WRITE_DEBOUNCE_MS);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [navigate]);

  const virtualItems = virtualizer.getVirtualItems();
  const getRow = useCallback(
    (rowIndex: number) => {
      const start = rowIndex * columns;
      return rows.slice(start, start + columns);
    },
    [rows, columns]
  );

  return (
    <PageShell>
      <PageHeader
        title="Staff"
        subtitle={`${staff.length} instructors, designers & directors across the activity`}
        backTo="/"
        backLabel="Home"
      />
      <div className="mb-6 max-w-sm">
        <Input
          type="search"
          placeholder="Search by name, role, or corps…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((vi) => {
          const row = getRow(vi.index);
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {row.map((s) => (
                <StaffCard key={s.person_id} staff={s} />
              ))}
            </div>
          );
        })}
      </div>

      {rows.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted-foreground">No staff match "{query}".</p>
      )}
    </PageShell>
  );
}

function StaffCard({ staff }: { staff: StaffSummary }) {
  const seasons = staff.seasons ?? [];
  const range =
    seasons.length > 1 ? `${seasons[seasons.length - 1]}–${seasons[0]}` : (seasons[0] ?? '');
  return (
    <Link to="/staff/$personId" params={{ personId: staff.person_id }} className="block">
      <Card className="h-full transition-colors hover:bg-accent/40">
        <CardContent className="flex items-center gap-3 p-3">
          <div className="size-12 shrink-0 overflow-hidden rounded-full bg-muted">
            <ProgressiveImage
              src={staff.photo_url}
              alt={staff.display_name}
              width={96}
              fit="cover"
              lazy
              assumeCached
              fallback={null}
              className="size-full"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{staff.display_name}</p>
            {staff.default_title && (
              <p className="truncate text-sm text-muted-foreground">{staff.default_title}</p>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {staff.corps_count} corps{range && ` · ${range}`}
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
