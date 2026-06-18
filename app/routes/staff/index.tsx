import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getStaffDirectory } from '@/lib/server-fns/hybrid';
import { staffCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import type { StaffSummary } from '@/lib/staff-directory';
import { ProgressiveImage } from '@/components/progressive-image';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((s) => (
          <StaffCard key={s.person_id} staff={s} />
        ))}
      </div>
      {rows.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted-foreground">No staff match “{query}”.</p>
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
