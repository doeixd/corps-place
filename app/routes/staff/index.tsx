import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState, useCallback } from 'react';
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

type StaffSearch = { q?: string };

export const Route = createFileRoute('/staff/')({
  validateSearch: (search: Record<string, unknown>): StaffSearch => {
    const q = typeof search.q === 'string' && search.q ? search.q : undefined;
    return q ? { q } : {};
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

const CARD_HEIGHT = 76; // px — height of one staff card row
const GAP = 12; // gap-3 = 12px
const ROW_HEIGHT = CARD_HEIGHT + GAP;

function StaffDirectoryContent({ staff }: { staff: StaffSummary[] }) {
  const [query, setQuery] = useState('');

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

  // Responsive column count: 1 on mobile, 2 at sm, 3 at lg
  const columns = 3; // fixed to worst-case — the window virtualizer handles layout

  const virtualizer = useWindowVirtualizer({
    count: Math.ceil(rows.length / columns),
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    gap: GAP,
  });

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
