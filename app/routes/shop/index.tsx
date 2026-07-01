import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Show } from 'jotai-solid-api';
import { getShopHome } from '@/lib/server-fns/hybrid';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { ShopSection } from '@/components/shop/shop-section';
import { GroupCard } from '@/components/shop/group-card';
import { CategoryCard } from '@/components/shop/category-card';
import { ProductCard } from '@/components/merch/product-card';
import { useBookmarks } from '@/stores/bookmark-store';
import type { ShopHome } from '@/lib/merch-types';
import { buildSeo } from '@/lib/seo';
import { SectionErrorBoundary } from '@/components/error-boundary';

export const Route = createFileRoute('/shop/')({
  loader: async (): Promise<ShopHome> => getShopHome(),
  head: () =>
    buildSeo({
      title: 'Shop Drum Corps Merch',
      description:
        'Browse official merch from drum corps across the activity — hoodies, tees, hats and more, all in one place.',
      path: '/shop',
    }),
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: ShopLanding,
});

function ShopLanding() {
  const { groups, categories } = Route.useLoaderData();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const bookmarks = useBookmarks();
  const recentBookmarks = bookmarks.slice(0, 12);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    navigate({ to: '/shop/all', search: term ? { q: term } : {} });
  };

  return (
    <PageShell>
      <PageHeader
        title="Shop"
        subtitle="Official merch from drum corps across the activity"
        backTo="/"
        backLabel="Home"
        actions={
          <Link
            to="/shop/all"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            All products
          </Link>
        }
      />

      {/* Search — hands off to the full catalog with the query applied. */}
      <form onSubmit={submitSearch} className="mb-4">
        <div className="relative w-full sm:w-96">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="search"
            placeholder="Search products or groups…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </form>

      {/* Quick category filter — horizontally scrollable chips linking to each
          category page (mirrors the catalog's category chips). */}
      <div className="carousel-scrollbar mb-8 flex gap-2 overflow-x-auto pb-2">
        {categories.map((c) => (
          <Link
            key={c.value}
            to="/shop/category/$cat"
            params={{ cat: c.value }}
            className="shrink-0 whitespace-nowrap rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            {c.value} <span className="text-text-muted">({c.count})</span>
          </Link>
        ))}
      </div>

      <div className="space-y-10">
        <Show when={recentBookmarks.length > 0}>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="inline-flex items-center gap-2 text-lg font-semibold">
                <Icon icon={FavouriteIcon} size="sm" className="text-primary" />
                Bookmarks
                <span className="text-sm font-normal text-text-secondary">{bookmarks.length}</span>
              </h2>
              <Link to="/shop/bookmarks" className="shrink-0 text-sm text-primary hover:underline">
                See all
              </Link>
            </div>
            <div className="carousel-scrollbar flex snap-x gap-3 overflow-x-auto pl-1 pt-2 pb-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {recentBookmarks.map((product) => (
                  <motion.div
                    key={product.productId}
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 50, mass: 1 }}
                    className="w-44 shrink-0 snap-start sm:w-48"
                  >
                    <ProductCard product={product} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
        </Show>

        <SectionErrorBoundary label="the shop grids">
          <ShopSection
            title="Shop by Group"
            count={groups.length}
            items={groups}
            getKey={(g) => g.storeId}
            renderCard={(g) => <GroupCard group={g} />}
          />

          <ShopSection
            title="Shop by Category"
            count={categories.length}
            items={categories}
            getKey={(c) => c.value}
            renderCard={(c) => <CategoryCard category={c} />}
          />
        </SectionErrorBoundary>
      </div>
    </PageShell>
  );
}
