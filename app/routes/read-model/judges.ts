import { createServerFileRoute } from '@tanstack/react-start/server';
import { getJudgeDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Judges index shard for judgesCollection.
export const ServerRoute = createServerFileRoute('/read-model/judges').methods({
  GET: async () => new Response(JSON.stringify(await getJudgeDirectory()), { headers: SHARD_HEADERS }),
});
