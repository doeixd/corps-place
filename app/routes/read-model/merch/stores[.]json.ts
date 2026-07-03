import { createFileRoute } from '@tanstack/react-router';
import { getMerchStores } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Merch stores detail shard (shop/stores.tsx loadDetailOrServer('merch/stores.json')).
export const Route = createFileRoute('/read-model/merch/stores.json')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getMerchStores()), { headers: SHARD_HEADERS }),
    },
  },
});
