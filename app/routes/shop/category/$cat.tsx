import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Show } from 'jotai-solid-api';
import { warmRoutesOnIdle } from '@/lib/warm-routes';
import { getShopCategory } from '@/lib/server-fns/hybrid';
import { selectProducts } from '@/lib/merch-filtering';
import type { MerchSort, MerchFilterContext } from '@/lib/merch-filtering';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { GroupMultiSelect } from '@/components/merch/group-multi-select';
import { ProductGrid } from '@/components/merch/product-grid';
import type { ShopCategory } from '@/lib/merch-types';
import { buildSeo } from '@/lib/seo';

const DISPLAY_CHUNK = 60;
const SORTS: { value: MerchSort; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price ↑' },
  { value: 'price-desc', label: 'Price ↓' },
  { value: 'name', label: 'Name' },
];

export const Route = createFileRoute('/shop/category/$cat')({
  validateSearch: (search: Record<string, unknown>): { l?: number } => {
    const rawL = search.l;
    const l = typeof rawL === 'number' ? rawL : Number(rawL);
    if (Number.isFinite(l) && l >= DISPLAY_CHUNK) return { l: Math.round(l) };
    return {};
  },
  loader: async ({ params }): Promise<ShopCategory> => {
    const category = await getShopCategory({ data: params.cat });
    if (!category) throw notFound();
    return category;
  },
  head: ({ loaderData, params }) => {
    const c = loaderData;
    if (!c) return {};
    return buildSeo({
      title: `${c.value} — Drum Corps Merch`,
      description: `Shop ${c.count} ${c.value.toLowerCase()} item${c.count === 1 ? '' : 's'} from drum corps across the activity.`,
      path: `/shop/category/${encodeURIComponent(params.cat)}`,
      image: c.products.find((p) => p.image)?.image ?? undefined,
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: CategoryPage,
});

function CategoryPage() {
  const category = Route.useLoaderData();
  const searchParams = Route.useSearch();
  const navigate = Route.useNavigate();

  // Background warm-up: idle-preload this category's product detail pages.
  const router = useRouter();
  useEffect(() => {
    const targets = category.products
      .flatMap((p) =>
        p.productId ? [{ to: '/shop/$productId', params: { productId: p.productId } }] : []
      )
      .slice(0, 40);
    return warmRoutesOnIdle(router as never, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, category.products.length]);
  const [search, setSearch] = useState('');
  const [stores, setStores] = useState<string[]>([]);
  const [sort, setSort] = useState<MerchSort>('featured');

  const filter: MerchFilterContext = {
    search,
    stores,
    price: 'all',
    category: 'all',
    inStock: false,
    sort,
  };
  const limit = searchParams.l ?? DISPLAY_CHUNK;
  const matches = useMemo(
    () => selectProducts(category.products, filter, null),
    [category.products, filter]
  );
  const visible = matches.slice(0, limit);
  const hasMore = matches.length > limit;

  // Which groups sell this category, by product count.
  const storeOptions = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const p of category.products) {
      const cur = counts.get(p.storeId);
      if (cur) cur.count += 1;
      else counts.set(p.storeId, { name: p.storeName, count: 1 });
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, v]) => ({ value: id, label: `${v.name} (${v.count})` }));
  }, [category.products]);

  return (
    <PageShell>
      <PageHeader
        title={category.value}
        subtitle={`${category.count} items across ${storeOptions.length} groups`}
        backTo="/shop"
        backLabel="Shop"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="search"
            placeholder={`Search ${category.value}…`}
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
        <GroupMultiSelect
          options={storeOptions}
          selected={stores}
          onChange={setStores}
          ariaLabel="Filter by group"
        />
      </div>

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
