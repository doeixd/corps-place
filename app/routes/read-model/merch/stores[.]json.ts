import { createServerFileRoute } from '@tanstack/react-start/server';
import { getMerchStores } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Merch stores detail shard (shop/stores.tsx loadDetailOrServer('merch/stores.json')).
export const ServerRoute = createServerFileRoute('/read-model/merch/stores.json').methods({
  GET: async () => new Response(JSON.stringify(await getMerchStores()), { headers: SHARD_HEADERS }),
});
