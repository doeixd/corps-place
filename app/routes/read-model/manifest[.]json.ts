import { createServerFileRoute } from '@tanstack/react-start/server';
import { getReadModelMeta } from '@/lib/read-model-meta';

/**
 * Read-model manifest — the single revalidated entry point for the client read
 * layer (app/db/read-model-manifest.ts). Maps each index collection to a
 * cache-bust-versioned shard URL and carries the global `version` used for detail
 * shards. Served dynamically (the static public/read-model/manifest.json is a
 * local-dev-only artifact, never shipped to prod), so this is what actually
 * activates TanStack DB collections + loadDetailOrServer in production.
 *
 * Short max-age + SWR: this is the ONLY request the client revalidates; the
 * `?v=`-tagged shards it points at are immutable and cache forever.
 */
const run = async (): Promise<Response> => {
  const meta = await getReadModelMeta();
  const v = encodeURIComponent(meta.version);
  const body = {
    schema_version: meta.schema_version,
    built_at: meta.built_at,
    current_season: meta.current_season,
    version: meta.version,
    // Relative to /read-model/ (see indexShardUrl). The ?v= makes each a new,
    // immutable URL per emit → the service worker CacheFirst-caches them.
    shards: {
      events: `events?v=${v}`,
      corps: `corps?v=${v}`,
      judges: `judges?v=${v}`,
      staff: `staff?v=${v}`,
    },
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30, stale-while-revalidate=86400',
    },
  });
};

export const ServerRoute = createServerFileRoute('/read-model/manifest.json').methods({ GET: run });
