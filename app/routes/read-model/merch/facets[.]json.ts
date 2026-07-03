import { createFileRoute } from '@tanstack/react-router';
import { getMerchFacets } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Merch facets detail shard (shop/all.tsx loadDetailOrServer('merch/facets.json')).
export const Route = createFileRoute('/read-model/merch/facets.json')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getMerchFacets()), { headers: SHARD_HEADERS }),
    },
  },
});
