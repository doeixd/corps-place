import { createFileRoute } from '@tanstack/react-router';
import { Show } from 'jotai-solid-api';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { corpsCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import type { CorpsSummary } from '@/lib/corps-directory';
import { searchString } from '@/lib/utils';
import * as CorpsPredicates from '@/predicates/corps';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { FilterChips } from '@/components/filter-chips';
import { CorpsCard } from '@/components/corps-card';
import { StaggeredGrid } from '@/components/staggered-grid';
import { Icon } from '@/components/icon';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Search01Icon, ViewIcon, ViewOffIcon } from '@/components/icons/generated';

// Class filter chips. `value` is the URL-friendly key carried in the query
// string and matches a DivisionCategory (plus 'all' and the derived 'alumni').
const DIVISION_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'world', label: 'World' },
  { value: 'open', label: 'Open' },
  { value: 'all-age', label: 'All Age' },
  { value: 'international', label: 'International' },
  { value: 'soundsport', label: 'SoundSport' },
  { value: 'alumni', label: 'Alumni' },
  { value: 'other', label: 'Other' },
] as const;

const DIVISION_VALUES = new Set<string>(DIVISION_FILTERS.map((f) => f.value));

type CorpsSearch = { cls?: string; q?: string; inactive?: boolean };

export const Route = createFileRoute('/corps/')({
  // Filters live in the query string so a filtered view is shareable/bookmarkable.
  validateSearch: (search: Record<string, unknown>): CorpsSearch => {
    const out: CorpsSearch = {};
    if (typeof search.cls === 'string' && search.cls !== 'all' && DIVISION_VALUES.has(search.cls))
      out.cls = search.cls;
    const q = searchString(search.q);
    if (q) out.q = q;
    if (search.inactive === true || search.inactive === 'true') out.inactive = true;
    return out;
  },
  // Fetch server-side during navigation (and preload on intent). Cached so repeat
  // navigations render instantly from the router cache.
  loader: async () => ({ corps: await getCorpsDirectory() }),
  staleTime: 60_000,
  component: CorpsDirectory,
});

function CorpsDirectory() {
  const { corps } = Route.useLoaderData();
  return (
    <HybridCollection collection={corpsCollection} loader={corps}>
      {(rows) => <CorpsDirectoryContent corps={rows} />}
    </HybridCollection>
  );
}

function CorpsDirectoryContent({ corps }: { corps: CorpsSummary[] }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const division = search.cls ?? 'all';
  const searchTerm = search.q ?? '';
  const includeInactive = search.inactive ?? false;

  const setDivision = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, cls: value === 'all' ? undefined : value }),
      replace: true,
      resetScroll: false,
    });
  const setSearchTerm = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, q: value || undefined }),
      replace: true,
      resetScroll: false,
    });
  const setIncludeInactive = (value: boolean) =>
    void navigate({
      search: (prev) => ({ ...prev, inactive: value ? true : undefined }),
      replace: true,
      resetScroll: false,
    });

  const inCategory = CorpsPredicates.inCategory(division);
  const matchesSearch = CorpsPredicates.hasSearchTerm(searchTerm)
    ? CorpsPredicates.matchesSearch(searchTerm)
    : null;
  const visibleCorps = includeInactive ? corps : corps.filter(CorpsPredicates.isCurrent);
  const filtered = visibleCorps.filter(
    (c) => inCategory(c) && (!matchesSearch || matchesSearch(c))
  );
  return (
    <PageShell>
      <PageHeader
        title="Corps Directory"
        subtitle="Drum corps and ensembles"
        backTo="/"
        backLabel="Home"
      />

      {/* Search */}
      <div className="mb-6 flex items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="text"
            placeholder="Search corps by name or city…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Class filter */}
      <FilterChips
        items={DIVISION_FILTERS}
        value={division}
        onSelect={setDivision}
        ariaLabel="Filter by division"
        className="mb-6"
      />

      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-semibold">
          Corps ({filtered.length}
          <Show when={searchTerm || division !== 'all'}>{` of ${visibleCorps.length}`}</Show>)
        </h2>
        <Toggle
          variant="outline"
          size="sm"
          pressed={includeInactive}
          onPressedChange={setIncludeInactive}
          aria-label={includeInactive ? 'Hide inactive corps' : 'Show inactive corps'}
          className="gap-1.5"
        >
          <Icon icon={includeInactive ? ViewOffIcon : ViewIcon} size="sm" />
          {includeInactive ? 'Hide Inactive' : 'Show Inactive'}
        </Toggle>
      </div>

      <Show
        when={filtered.length > 0}
        fallback={
          <StatusCard
            tone="empty"
            title="No matching corps"
            description="Try a different search term or class."
          />
        }
      >
        {/* `animateLayout` adds the filter choreography: survivors rearrange
            (`layout`) and removed cards fade out (`exit`) as the filter changes. */}
        <StaggeredGrid
          items={filtered}
          getKey={(c) => c.corps_key}
          renderItem={(c) => <CorpsCard corps={c} />}
          step={0.06}
          animateLayout
        />
      </Show>
    </PageShell>
  );
}
