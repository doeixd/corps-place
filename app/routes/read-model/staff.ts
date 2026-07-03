import { createFileRoute } from '@tanstack/react-router';
import { getStaffDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Staff index shard for staffCollection.
export const Route = createFileRoute('/read-model/staff')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getStaffDirectory()), { headers: SHARD_HEADERS }),
    },
  },
});
