import { createServerFileRoute } from '@tanstack/react-start/server';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Corps index shard for corpsCollection.
export const ServerRoute = createServerFileRoute('/read-model/corps').methods({
  GET: async () => new Response(JSON.stringify(await getCorpsDirectory()), { headers: SHARD_HEADERS }),
});
