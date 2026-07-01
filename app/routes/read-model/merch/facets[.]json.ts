import { createServerFileRoute } from '@tanstack/react-start/server';
import { getMerchFacets } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Merch facets detail shard (shop/all.tsx loadDetailOrServer('merch/facets.json')).
export const ServerRoute = createServerFileRoute('/read-model/merch/facets.json').methods({
  GET: async () => new Response(JSON.stringify(await getMerchFacets()), { headers: SHARD_HEADERS }),
});
