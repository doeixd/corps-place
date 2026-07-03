import { createFileRoute } from '@tanstack/react-router';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Corps index shard for corpsCollection.
export const Route = createFileRoute('/read-model/corps')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getCorpsDirectory()), { headers: SHARD_HEADERS }),
    },
  },
});
