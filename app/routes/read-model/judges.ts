import { createFileRoute } from '@tanstack/react-router';
import { getJudgeDirectory } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Judges index shard for judgesCollection.
export const Route = createFileRoute('/read-model/judges')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getJudgeDirectory()), { headers: SHARD_HEADERS }),
    },
  },
});
