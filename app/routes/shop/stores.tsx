import { createFileRoute } from '@tanstack/react-router';
import { getMerchStores } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StoreCard } from '@/components/merch/store-card';
import type { MerchStoreSummary } from '@/lib/merch-types';
import { seoHead, breadcrumbLd } from '@/lib/seo';

export const Route = createFileRoute('/shop/stores')({
  loader: async () => ({
    stores: await loadDetailOrServer<MerchStoreSummary[]>('merch/stores.json', () =>
      getMerchStores()
    ),
  }),
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    return seoHead({
      title: 'Drum Corps Merch Stores — Shop by Corps',
      description: `Browse official merch storefronts from ${d.stores.length} drum corps — shirts, hats, hoodies and gear, with prices and links on DrumCorps.app.`,
      path: '/shop/stores',
      jsonLd: [
        breadcrumbLd([
          { name: 'Shop', path: '/shop' },
          { name: 'Stores', path: '/shop/stores' },
        ]),
      ],
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: MerchStores,
});

function MerchStores() {
  const { stores } = Route.useLoaderData();
  const withProducts = stores.filter((s) => s.productCount > 0).length;

  return (
    <PageShell>
      <PageHeader
        title="Stores"
        subtitle={`${stores.length} drum-corps stores · ${withProducts} with browsable catalogs`}
        backTo="/shop"
        backLabel="Shop"
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stores.map((s) => (
          <StoreCard key={s.storeId} store={s} />
        ))}
      </div>
    </PageShell>
  );
}
