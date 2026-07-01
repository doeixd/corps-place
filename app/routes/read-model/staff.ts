import { createServerFileRoute } from '@tanstack/react-start/server';
import { getStaffDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Staff index shard for staffCollection.
export const ServerRoute = createServerFileRoute('/read-model/staff').methods({
  GET: async () => new Response(JSON.stringify(await getStaffDirectory()), { headers: SHARD_HEADERS }),
});
