import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Show } from 'jotai-solid-api';
import { getShopGroup } from '@/lib/server-fns/hybrid';
import { selectProducts } from '@/lib/merch-filtering';
import type { MerchSort, MerchFilterContext } from '@/lib/merch-filtering';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Search01Icon, LinkSquare02Icon } from '@/components/icons/generated';
import { FilterChips } from '@/components/filter-chips';
import { GroupLogo } from '@/components/shop/group-logo';
import { ProductGrid } from '@/components/merch/product-grid';
import type { ShopGroup } from '@/lib/merch-types';
import { buildSeo } from '@/lib/seo';

const DISPLAY_CHUNK = 60;

/** A concrete, ~150-char meta description: real product count + the store's top
 *  categories so the snippet reads like the actual catalog, not boilerplate. */
function shopGroupDescription(g: ShopGroup): string {
  const cats = g.categories.slice(0, 3).map((c) => c.value);
  const what = cats.length ? `${cats.join(', ')} and more` : 'apparel, gear and accessories';
  if (g.count === 0) {
    return `Browse ${g.name}'s drum corps merch storefront — apparel, gear and more — on DrumCorps.app.`;
  }
  return `Shop ${g.count} ${g.name} drum corps merch item${g.count === 1 ? '' : 's'}: ${what}. Prices, photos and links on DrumCorps.app.`;
}

const SORTS: { value: MerchSort; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price ↑' },
  { value: 'price-desc', label: 'Price ↓' },
  { value: 'name', label: 'Name' },
];

export const Route = createFileRoute('/shop/group/$storeId')({
  validateSearch: (search: Record<string, unknown>): { l?: number } => {
    const rawL = search.l;
    const l = typeof rawL === 'number' ? rawL : Number(rawL);
    if (Number.isFinite(l) && l >= DISPLAY_CHUNK) return { l: Math.round(l) };
    return {};
  },
  loader: async ({ params }): Promise<ShopGroup> => {
    const group = await getShopGroup({ data: params.storeId });
    if (!group) throw notFound();
    return group;
  },
  head: ({ loaderData, params }) => {
    const g = loaderData;
    if (!g) return {};
    return buildSeo({
      title: `${g.name} — Drum Corps Merch`,
      description: shopGroupDescription(g),
      path: `/shop/group/${encodeURIComponent(params.storeId)}`,
      image: g.products.find((p) => p.image)?.image ?? undefined,
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: GroupStorefront,
});

function GroupStorefront() {
  const group = Route.useLoaderData();
  const searchParams = Route.useSearch();
  const navigate = Route.useNavigate();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<MerchSort>('featured');

  const filter: MerchFilterContext = {
    search,
    stores: [],
    price: 'all',
    category,
    inStock: false,
    sort,
  };
  const limit = searchParams.l ?? DISPLAY_CHUNK;
  const matches = useMemo(
    () => selectProducts(group.products, filter, null),
    [group.products, filter]
  );
  const visible = matches.slice(0, limit);
  const hasMore = matches.length > limit;

  const categoryChips = [
    { value: 'all', label: 'All' },
    ...group.categories.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` })),
  ];

  return (
    <PageShell>
      <BackLink to="/shop" label="Shop" />

      <div className="mt-4 mb-6 space-y-4">
        <div className="flex items-center gap-5 sm:gap-6">
          <GroupLogo
            name={group.name}
            logo={group.logo}
            storeLogo={group.storeLogo}
            width={112}
            className="size-24 sm:size-28"
          />
          <div className="min-w-0 space-y-2">
            <h1 className="break-words text-3xl font-bold leading-tight text-text-primary sm:text-[2.5rem]">
              {group.corpsSlug ? (
                <Link
                  to="/corps/$slug/{-$season}"
                  params={{ slug: group.corpsSlug }}
                  className="hover:text-primary hover:underline"
                >
                  {group.name}
                </Link>
              ) : (
                group.name
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-base text-text-secondary">
              <span>{group.count} items</span>
              <span className="text-text-muted">&middot;</span>
              <a
                href={group.storeUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
              >
                <Icon icon={LinkSquare02Icon} size="sm" />
                Visit store
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="search"
            placeholder="Search this store…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSort(s.value)}
              className={
                sort === s.value
                  ? 'rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground'
                  : 'rounded-md px-3 py-1.5 text-sm text-text-secondary hover:text-foreground'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <Show when={group.categories.length > 0}>
        <FilterChips
          items={categoryChips}
          value={category}
          onSelect={setCategory}
          className="mb-6"
          ariaLabel="Filter by category"
        />
      </Show>

      <Show
        when={visible.length > 0}
        fallback={<p className="py-12 text-center text-text-secondary">No matching products.</p>}
      >
        <ProductGrid products={visible} />
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
