import { createFileRoute, notFound } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Show } from 'jotai-solid-api';
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
  staleTime: 60_000,
  component: CategoryPage,
});

function CategoryPage() {
  const category = Route.useLoaderData();
  const [search, setSearch] = useState('');
  const [stores, setStores] = useState<string[]>([]);
  const [sort, setSort] = useState<MerchSort>('featured');
  const [limit, setLimit] = useState(DISPLAY_CHUNK);

  const filter: MerchFilterContext = {
    search,
    stores,
    price: 'all',
    category: 'all',
    inStock: false,
    sort,
  };
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
            onClick={() => setLimit((l) => l + DISPLAY_CHUNK)}
          >
            Load more products ({visible.length} of {matches.length})
          </Button>
        </div>
      </Show>
    </PageShell>
  );
}
