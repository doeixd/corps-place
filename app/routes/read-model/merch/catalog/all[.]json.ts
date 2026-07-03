import { createFileRoute } from '@tanstack/react-router';
import { getMerchCatalog } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Merch full-catalog detail shard (shop/all.tsx loadDetailOrServer('merch/catalog/all.json')).
export const Route = createFileRoute('/read-model/merch/catalog/all.json')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getMerchCatalog()), { headers: SHARD_HEADERS }),
    },
  },
});
