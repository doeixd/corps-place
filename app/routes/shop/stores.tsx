import { createFileRoute } from '@tanstack/react-router';
import { getMerchStores } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StoreCard } from '@/components/merch/store-card';
import type { MerchStoreSummary } from '@/lib/merch-types';

export const Route = createFileRoute('/shop/stores')({
  loader: async () => ({
    stores: await loadDetailOrServer<MerchStoreSummary[]>('merch/stores.json', () =>
      getMerchStores()
    ),
  }),
  staleTime: 60_000,
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
