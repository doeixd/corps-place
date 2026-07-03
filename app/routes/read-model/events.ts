import { createFileRoute } from '@tanstack/react-router';
import { getHybridAllEvents } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Events index shard for eventsCollection (app/db/collections.ts). Same array the
// route loaders use (getHybridAllEvents), so collection ⇄ loader rows stay in
// lockstep. Immutable: the URL carries the manifest ?v=, which changes per emit.
export const Route = createFileRoute('/read-model/events')({
  server: {
    handlers: {
  GET: async () => new Response(JSON.stringify(await getHybridAllEvents()), { headers: SHARD_HEADERS }),
    },
  },
});
