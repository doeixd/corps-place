import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show } from 'jotai-solid-api';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { corpsCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import { warmRoutesOnIdle, warmImagesOnIdle, WARM_ABOVE_FOLD } from '@/lib/warm-routes';
import { proxiedImage } from '@/lib/media';
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
import { seoHead, breadcrumbLd } from '@/lib/seo';

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
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    const n = d.corps.length;
    return seoHead({
      title: 'Drum Corps Directory — Corps, Scores & Shows',
      description: `Browse ${n} drum corps — World Class, Open Class and all-age units — with scores, schedules, show programs, staff and merch on DrumCorps.app.`,
      path: '/corps',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Corps', path: '/corps' },
        ]),
      ],
    });
  },
  // The corps directory is static read-model data (changes only on a re-emit, and
  // the client hard-reloads on a new deploy), so keep the loader result fresh for
  // the whole session — repeat navigations render instantly from the router cache
  // instead of re-running getCorpsDirectory every minute.
  staleTime: Infinity,
  gcTime: Infinity,
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

  // Background warm-up: preload the detail route for the FIRST FEW (above-the-fold)
  // corps only. The router's `defaultPreload: 'intent'` already preloads any card
  // on hover/touch-start, so this only needs to cover the cards visible before the
  // user interacts — NOT the whole directory. Each detail warm cascades into ~5
  // read-model shard fetches, so warming 40 flooded mobile with ~200 requests; a
  // small cap keeps the top row instant while intent-preload handles the rest.
  const router = useRouter();
  useEffect(() => {
    const targets = corps
      .flatMap((c) =>
        c.slug ? [{ to: '/corps/$slug/{-$season}', params: { slug: c.slug } }] : []
      )
      .slice(0, WARM_ABOVE_FOLD);
    return warmRoutesOnIdle(router as never, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, corps.length]);

  // Also background-preload the corps cover/hero images (only ~15% of corps have
  // one) at the width the detail page's hero will request, so that hero renders
  // instantly on click. Pairs with the route warm above.
  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Mirror the detail cover's sizes: 28rem (448px) on wide screens, else 100vw.
    const cssWidth = window.innerWidth >= 1024 ? 448 : window.innerWidth;
    const widths = [384, 480, 640, 768, 896, 1024];
    const need = cssWidth * dpr;
    const w = widths.find((x) => x >= need) ?? 1024;
    const urls = corps
      .flatMap((c) => (c.corps_photo ? [proxiedImage(c.corps_photo, { width: w, assumeCached: true })] : []))
      .filter((u): u is string => !!u)
      .slice(0, WARM_ABOVE_FOLD);
    return warmImagesOnIdle(urls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corps.length]);

  const division = search.cls ?? 'all';
  const searchTerm = search.q ?? '';
  const includeInactive = search.inactive ?? false;

  const setDivision = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, cls: value === 'all' ? undefined : value }),
      replace: true,
      resetScroll: false,
    });
  // The input is controlled locally and the URL write is debounced: navigating
  // per keystroke re-ran the router (history.replaceState, every <Link>'s
  // active-state check, the full grid diff) on each character — ~19ms of
  // main-thread block per key on a mid phone.
  const [pendingSearch, setPendingSearch] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setSearchTerm = (value: string) => {
    setPendingSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPendingSearch(null);
      void navigate({
        search: (prev) => ({ ...prev, q: value || undefined }),
        replace: true,
        resetScroll: false,
      });
    }, 250);
  };
  const setIncludeInactive = (value: boolean) =>
    void navigate({
      search: (prev) => ({ ...prev, inactive: value ? true : undefined }),
      replace: true,
      resetScroll: false,
    });

  const inCategory = CorpsPredicates.inCategory(division);
  const liveTerm = pendingSearch ?? searchTerm;
  const matchesSearch = CorpsPredicates.hasSearchTerm(liveTerm)
    ? CorpsPredicates.matchesSearch(liveTerm)
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
            value={pendingSearch ?? searchTerm}
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
          <Show when={liveTerm || division !== 'all'}>{` of ${visibleCorps.length}`}</Show>)
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
            (`layout`) and removed cards fade out (`exit`) as the filter changes.
            Disabled while a keystroke is pending: FLIP measurement + exit
            animations per character were most of the typing jank. */}
        <StaggeredGrid
          items={filtered}
          getKey={(c) => c.corps_key}
          // First screenful of logos loads eagerly (the post-paint lazy-load
          // trickle reads as "still loading"); the rest stay lazy.
          renderItem={(c, i) => <CorpsCard corps={c} eagerLogo={i < 12} />}
          step={0.06}
          animateLayout={pendingSearch === null}
        />
      </Show>
    </PageShell>
  );
}
