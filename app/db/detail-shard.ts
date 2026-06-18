// On-demand detail-shard loader (DATA_LAYER_DECISION §3). Detail pages SSR from
// their route loader for first paint; on *client* navigation the loader can fetch
// the tiny, CDN-cached static shard instead of round-tripping a server fn. Shards
// are cache-busted with the manifest's global `version` token, so a nightly emit
// invalidates them exactly once.

import { detailShardUrl, loadReadModelManifest } from './read-model-manifest';

/**
 * Fetch a per-entity detail shard, e.g. `corps/blue-devils.json`,
 * `judges/<id>.json`, `recaps/<competition>.json`. Returns `null` on 404 so the
 * caller can fall back to its server fn (stale snapshot / not-yet-emitted entity).
 */
export async function loadDetailShard<T>(rel: string): Promise<T | null> {
  const manifest = await loadReadModelManifest();
  const res = await fetch(detailShardUrl(manifest, rel));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`detail shard "${rel}" ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Prefer the static shard on the client, falling back to `serverFn()` when off
 * the client, on a 404, or on any fetch error. SSR always uses the server fn.
 */
export async function loadDetailOrServer<T>(rel: string, serverFn: () => Promise<T>): Promise<T> {
  if (typeof window !== 'undefined') {
    try {
      const shard = await loadDetailShard<T>(rel);
      if (shard !== null) return shard;
    } catch (err) {
      console.error(`[read-model] detail shard "${rel}" failed; falling back to server`, err);
    }
  }
  return serverFn();
}
