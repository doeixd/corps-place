import { createServerFileRoute } from '@tanstack/react-start/server';
import { getJudgeProfile } from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Detail shard (loadDetailOrServer requests `.../<id>.json?v=`). Captures the full
// segment and strips the .json suffix, then wraps the fallback server fn so the
// shard byte-matches the server-fn path. Cache-busted by the manifest ?v=.
export const ServerRoute = createServerFileRoute('/read-model/judges/$judgeId').methods({
  GET: async ({ params }) => {
    const id = params.judgeId.replace(/\.json$/i, '');
    return new Response(JSON.stringify(await getJudgeProfile({ data: id })), { headers: SHARD_HEADERS });
  },
});
