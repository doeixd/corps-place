import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useCallback, useEffect } from 'react';
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
import { useNavigate, useSearch } from '@tanstack/react-router';

type StaffSearch = { q?: string; s?: number };

export const Route = createFileRoute('/staff/')({
  validateSearch: (search: Record<string, unknown>): StaffSearch => {
    const out: StaffSearch = {};
    if (typeof search.q === 'string' && search.q) out.q = search.q;
    if (typeof search.s === 'number' && search.s > 0) out.s = search.s;
    return out;
  },
  loader: async () => ({ staff: await getStaffDirectory() }),
  staleTime: 60_000,
  component: StaffDirectory,
});

function StaffDirectory() {
  const { staff } = Route.useLoaderData();
  return (
    <HybridCollection collection={staffCollection} loader={staff}>
      {(rows) => <StaffDirectoryContent staff={rows} />}
    </HybridCollection>
  );
}

const CARD_HEIGHT = 76;
const GAP = 12;
const ROW_HEIGHT = CARD_HEIGHT + GAP;

function StaffDirectoryContent({ staff }: { staff: StaffSummary[] }) {
  const search = useSearch({ from: '/staff/' });
  const navigate = useNavigate();
  const columns = 3;

  const query = search.q ?? '';
  const setQuery = (q: string) =>
    void navigate({ search: (prev) => ({ ...prev, q: q || undefined }), replace: true });

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

  // Restore scroll position from URL on back-button navigation.
  useEffect(() => {
    if (search.s && search.s > 0) {
      requestAnimationFrame(() => window.scrollTo(0, search.s));
    }
  }, []);

  // Save scroll position to URL on scroll (debounced).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        navigate({
          search: (prev) => ({ ...prev, s: window.scrollY || undefined }),
          replace: true,
        });
      }, 200);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, []);

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
