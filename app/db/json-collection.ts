// Effect-free TanStack DB collection backed by a static read-model index shard
// (DATA_LAYER_DECISION §2/§3). The browser bundle stays Effect-free: reads are
// plain `fetch` of a versioned JSON shard, streamed into the collection in
// chunks so a large array never blocks the main thread, with `markReady()` after
// the first chunk so the UI can render progressively.

import type { CollectionConfig } from '@tanstack/db';
import {
  indexShardUrl,
  loadReadModelManifest,
  type ReadModelManifest,
} from './read-model-manifest';

const CHUNK_SIZE = 500;

/**
 * Build collection options that bulk-load one read-model index shard
 * (events/corps/judges) into a TanStack DB collection. Resolve the versioned
 * shard URL from the manifest, fetch it, and write rows in chunked sync
 * transactions.
 */
export function jsonIndexCollectionOptions<T extends object>(opts: {
  id: string;
  getKey: (row: T) => string | number;
  shard: keyof ReadModelManifest['shards'];
}): CollectionConfig<T, string | number> {
  return {
    id: opts.id,
    getKey: opts.getKey,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        // Server-side (SSR) renders from the route loader, not the collection.
        // Skip the network load entirely there — a relative-URL fetch has no base
        // in Node — and let the client hydrate the collection after first paint.
        if (typeof window === 'undefined') {
          markReady();
          return;
        }

        let cancelled = false;

        void (async () => {
          try {
            const manifest = await loadReadModelManifest();
            if (cancelled) return;
            const res = await fetch(indexShardUrl(manifest, opts.shard));
            if (!res.ok) throw new Error(`${opts.shard} shard ${res.status}`);
            const rows = (await res.json()) as T[];
            if (cancelled) return;

            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
              begin();
              for (const row of rows.slice(i, i + CHUNK_SIZE)) {
                write({ type: 'insert', value: row });
              }
              commit();
              // Usable after the first chunk; keep streaming the rest.
              if (i === 0) markReady();
            }
            // Empty shard still needs to leave the loading state.
            if (rows.length === 0) markReady();
          } catch (err) {
            // Never wedge the collection in "loading" forever — mark ready so
            // consumers fall back to their SSR loader data.
            console.error(`[read-model] failed to load "${opts.shard}" index shard`, err);
            markReady();
          }
        })();

        return () => {
          cancelled = true;
        };
      },
    },
  };
}
