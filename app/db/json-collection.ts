// Effect-free TanStack DB collection backed by a static read-model index shard
// (DATA_LAYER_DECISION §2/§3). The browser bundle stays Effect-free: reads are
// plain `fetch` of a versioned JSON shard, streamed into the collection in
// chunks so a large array never blocks the main thread, with `markReady()` after
// the first chunk so the UI can render progressively.

// Import the core type via '@tanstack/react-db' (it re-exports '@tanstack/db'
// via `export *`); importing '@tanstack/db' directly fails to resolve here.
import type { CollectionConfig } from '@tanstack/react-db';
import {
  indexShardUrl,
  loadReadModelManifest,
  type ReadModelManifest,
} from './read-model-manifest';

const CHUNK_SIZE = 500;

// One-shot seed rows per collection id, registered by HybridCollection from the
// route loader's payload BEFORE the first subscription triggers sync. The loader
// and the shard read the same read-model, so when a seed is present the sync can
// skip the network fetch entirely — the directory otherwise downloads twice on
// every cold visit (server-fn for SSR + shard for the collection). Consumed on
// use; a later re-sync (collection GC'd and re-subscribed) falls back to the
// fetch so long-lived sessions still pick up a re-emitted read-model.
const collectionSeeds = new Map<string, object[]>();
// Ids created by jsonIndexCollectionOptions — seeds for any other collection
// (e.g. fantasy standings, which sync differently) are ignored, not leaked.
const indexCollectionIds = new Set<string>();

/** Register loader rows as the initial sync payload for a json-index collection. */
export function seedIndexCollection(id: string | undefined, rows: object[]): void {
  if (id && indexCollectionIds.has(id) && rows.length > 0 && !collectionSeeds.has(id))
    collectionSeeds.set(id, rows);
}

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
  indexCollectionIds.add(opts.id);
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

        // Seeded from the route loader → same data the shard would return;
        // write it synchronously and skip the duplicate network load.
        const seed = collectionSeeds.get(opts.id) as T[] | undefined;
        if (seed) {
          collectionSeeds.delete(opts.id);
          for (let i = 0; i < seed.length; i += CHUNK_SIZE) {
            begin();
            for (const row of seed.slice(i, i + CHUNK_SIZE)) {
              write({ type: 'insert', value: row });
            }
            commit();
            if (i === 0) markReady();
          }
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
