import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { Show } from 'jotai-solid-api';
import { getMerchFacets, getMerchCatalog } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import { selectProducts } from '@/lib/merch-filtering';
import type { MerchSort } from '@/lib/merch-filtering';
import { merchFilterMachine, merchFilterSearchCodec } from '@/machines/merch-filter-machine';
import type { MerchSearch } from '@/machines/merch-filter-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { searchString } from '@/lib/utils';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StatusCard } from '@/components/status-card';
import { FilterChips } from '@/components/filter-chips';
import { GroupMultiSelect } from '@/components/merch/group-multi-select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { ProductGrid } from '@/components/merch/product-grid';
import { SectionErrorBoundary } from '@/components/error-boundary';
import type { MerchProductSummary, MerchFacets } from '@/lib/merch-types';
import { buildSeo } from '@/lib/seo';

interface MerchCatalog {
  total: number;
  items: MerchProductSummary[];
}

// How many products to render per "page" client-side (filtering/sorting runs over
// the full index; this only bounds what's painted).
const DISPLAY_CHUNK = 60;

const SORTS: { value: MerchSort; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price ↑' },
  { value: 'price-desc', label: 'Price ↓' },
  { value: 'name', label: 'Name' },
];

export const Route = createFileRoute('/shop/all')({
  validateSearch: (search: Record<string, unknown>): MerchSearch & { l?: number } => {
    const out: MerchSearch = {};
    const q = searchString(search.q);
    if (q) out.q = q;
    const store = searchString(search.store);
    if (store) out.store = store;
    const price = searchString(search.price);
    if (price) out.price = price;
    const cat = searchString(search.cat);
    if (cat) out.cat = cat;
    if (searchString(search.stock) === '1') out.stock = '1';
    const sort = searchString(search.sort);
    if (sort === 'price-asc' || sort === 'price-desc' || sort === 'name') out.sort = sort;
    const rawL = search.l;
    const l = typeof rawL === 'number' ? rawL : Number(rawL);
    if (Number.isFinite(l) && l >= DISPLAY_CHUNK)
      (out as Record<string, unknown>).l = Math.round(l);
    return out as MerchSearch & { l?: number };
  },
  loader: async () => {
    const [facets, catalog] = await Promise.all([
      loadDetailOrServer<MerchFacets>('merch/facets.json', () => getMerchFacets()),
      loadDetailOrServer<MerchCatalog>('merch/catalog/all.json', () => getMerchCatalog()),
    ]);
    return { facets, catalog };
  },
  head: () =>
    buildSeo({
      title: 'All Products — Shop Drum Corps Merch',
      description:
        'Search and filter the full drum corps merch catalog — every product across all groups.',
      path: '/shop/all',
    }),
  staleTime: 60_000,
  component: MerchCatalog,
});

function MerchCatalog() {
  const { facets, catalog } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const codec = useMemo(() => merchFilterSearchCodec(), []);
  const [state, send] = useMachine(merchFilterMachine, { input: codec.decode(search) });
  const filter = state.context;
  useSearchSync({
    context: filter,
    send,
    search,
    codec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
  });

  // Load-more limit persisted in the URL so it survives back-navigation
  // (the router's scrollRestoration:true restores the viewport position,
  // and the URL's l param ensures enough items are rendered to fill it).
  const limit = search.l ?? DISPLAY_CHUNK;
  const matches = useMemo(
    () => selectProducts(catalog.items, filter, facets),
    [catalog.items, filter, facets]
  );
  const visible = matches.slice(0, limit);
  const hasMore = matches.length > limit;

  const storeOptions = facets.stores.map((s) => ({
    value: s.storeId,
    label: `${s.name} (${s.count})`,
  }));
  const priceChips = [
    { value: 'all', label: 'Any price' },
    ...facets.priceBuckets.map((b) => ({ value: b.label, label: `${b.label} (${b.count})` })),
  ];
  const categoryChips = [
    { value: 'all', label: 'All categories' },
    ...facets.categories.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` })),
  ];

  return (
    <PageShell>
      <PageHeader
        title="All Products"
        subtitle={`${catalog.total} products from ${facets.stores.length} drum corps stores`}
        backTo="/shop"
        backLabel="Shop"
        actions={
          <Link
            to="/shop/stores"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            Browse by store
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="text"
            placeholder="Search products or stores…"
            value={filter.search}
            onChange={(e) => send({ type: 'SET_SEARCH', search: e.target.value })}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => send({ type: 'SET_SORT', sort: s.value })}
              className={
                filter.sort === s.value
                  ? 'rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground'
                  : 'rounded-md px-3 py-1.5 text-sm text-text-secondary hover:text-foreground'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <GroupMultiSelect
          options={storeOptions}
          selected={filter.stores}
          onChange={(stores) => send({ type: 'SET_STORES', stores })}
          allLabel="All stores"
          noun="stores"
          ariaLabel="Filter by store"
        />
        <button
          type="button"
          onClick={() => send({ type: 'TOGGLE_IN_STOCK' })}
          className={
            filter.inStock
              ? 'rounded-full border border-primary/60 bg-primary/10 px-3 py-1.5 text-sm text-primary'
              : 'rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground'
          }
        >
          In stock
        </button>
      </div>

      <FilterChips
        items={priceChips}
        value={filter.price}
        onSelect={(price) => send({ type: 'SET_PRICE', price })}
        className="mb-3"
        ariaLabel="Filter by price"
      />
      <Show when={facets.categories.length > 0}>
        <FilterChips
          items={categoryChips}
          value={filter.category}
          onSelect={(category) => send({ type: 'SET_CATEGORY', category })}
          className="mb-6"
          ariaLabel="Filter by category"
        />
      </Show>

      <Show
        when={visible.length > 0}
        fallback={
          <StatusCard
            tone="empty"
            title="No matching products"
            description="Try a different search, store, or price filter."
          />
        }
      >
        <SectionErrorBoundary label="the product grid">
          <ProductGrid products={visible} />
        </SectionErrorBoundary>
      </Show>

      <Show when={hasMore}>
        <div className="mt-6 flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              navigate({
                search: (prev) => ({ ...prev, l: (prev.l ?? DISPLAY_CHUNK) + DISPLAY_CHUNK }),
                replace: true,
                resetScroll: false,
              })
            }
          >
            Load more products ({visible.length} of {matches.length})
          </Button>
        </div>
      </Show>
    </PageShell>
  );
}
