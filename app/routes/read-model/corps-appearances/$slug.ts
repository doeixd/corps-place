import { createFileRoute } from '@tanstack/react-router';
import { getCorpsAppearances } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Detail shard (loadDetailOrServer requests `.../<id>.json?v=`). Captures the full
// segment and strips the .json suffix, then wraps the fallback server fn so the
// shard byte-matches the server-fn path. Cache-busted by the manifest ?v=.
export const Route = createFileRoute('/read-model/corps-appearances/$slug')({
  server: {
    handlers: {
  GET: async ({ params }) => {
    const id = params.slug.replace(/\.json$/i, '');
    return new Response(JSON.stringify(await getCorpsAppearances({ data: id })), { headers: SHARD_HEADERS });
  },
    },
  },
});
