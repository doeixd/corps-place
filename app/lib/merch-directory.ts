// MerchDirectoryService — the Effect service behind the merch server functions
// (docs/plans/MERCH_PLAN.md §6). Mirrors CorpsDirectoryService: a Context.Service
// + Layer.effect, a single long-lived libsql client owned by the service, tagged
// errors on the Effect channel, Effect.fn methods, and a Ref-cached snapshot so
// the catalog is built once per TTL rather than per request.
//
// readOrBuild: in prod it reads the frozen rm_merch_* tables from the read-model DB
// (Turso replica) via readMerchSnapshot — no relational DB on the request path; on
// the dev box (no read-model) it builds from the big DB. JSON shards remain a
// client-nav fast path. Same shape both ways, so no drift.

import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import * as path from 'node:path';
import {
  buildMerchCatalogIndex,
  buildMerchProductDetails,
  buildMerchStores,
  buildMerchFacets,
  buildCorpsMerchTeasers,
  type MerchProductSummary,
  type MerchProductDetail,
  type MerchStoreSummary,
  type MerchFacets,
  type CorpsMerchTeaser,
} from '@sdk/src/readModel/builders/merch.js';
import { readMerchSnapshot } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import type { MerchCatalogPage } from '@/lib/merch-types';

export class MerchDirectoryDataError extends Schema.TaggedErrorClass<MerchDirectoryDataError>()(
  'MerchDirectoryDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

// Lazy (not module-top) so importing this server module stays browser-safe.
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);

// One shared, long-lived libsql client owned by the service (see corps-directory).
let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

const merchDataError = (message: string) => (cause: unknown) =>
  new MerchDirectoryDataError({ message, details: String(cause) });

const MERCH_PAGE_SIZE = 200;
const MERCH_CACHE_MS = 10 * 60_000;

interface MerchSnapshot {
  index: MerchProductSummary[];
  details: Map<string, MerchProductDetail>;
  stores: MerchStoreSummary[];
  facets: MerchFacets;
  teasers: Map<string, CorpsMerchTeaser>;
}

// Build the merch snapshot once. Read path (prod): read the frozen rm_merch_*
// tables from the read-model DB (Turso embedded replica) — same readOrBuild pattern
// as CorpsDirectoryService, so the serving container never needs the 3.4 GB
// relational DB. Build path (dev box, no read-model): run the builders against the
// big DB. Either way a failure becomes a tagged error on the Effect channel.
const buildSnapshot: Effect.Effect<MerchSnapshot, MerchDirectoryDataError> = Effect.suspend(() => {
  if (readModelEnabled()) {
    return Effect.tryPromise({
      try: () => readMerchSnapshot(getReadModelClient()),
      catch: merchDataError('Could not read the merch read-model.'),
    });
  }
  const db = getDb();
  return Effect.all(
    {
      index: Effect.tryPromise({
        try: () => buildMerchCatalogIndex(db),
        catch: merchDataError('Could not load the merch catalog index.'),
      }),
      details: Effect.tryPromise({
        try: () => buildMerchProductDetails(db),
        catch: merchDataError('Could not load merch product details.'),
      }),
      stores: Effect.tryPromise({
        try: () => buildMerchStores(db),
        catch: merchDataError('Could not load merch stores.'),
      }),
      facets: Effect.tryPromise({
        try: () => buildMerchFacets(db),
        catch: merchDataError('Could not load merch facets.'),
      }),
      teasers: Effect.tryPromise({
        try: () => buildCorpsMerchTeasers(db),
        catch: merchDataError('Could not load corps merch teasers.'),
      }),
    },
    { concurrency: 'unbounded' }
  );
});

const makeMerchDirectoryService = Effect.gen(function* () {
  // Ref-held TTL cache so the catalog is built once per window, not per request.
  const cacheRef = yield* Ref.make<{
    expiresAt: number;
    snapshot: MerchSnapshot;
  } | null>(null);

  const snapshot = Effect.gen(function* () {
    const cached = yield* Ref.get(cacheRef);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.snapshot;
    const fresh = yield* buildSnapshot;
    yield* Ref.set(cacheRef, {
      expiresAt: now + MERCH_CACHE_MS,
      snapshot: fresh,
    });
    return fresh;
  });

  const listStores = Effect.fn('MerchDirectoryService.listStores')(function* () {
    return (yield* snapshot).stores;
  });

  const getFacets = Effect.fn('MerchDirectoryService.getFacets')(function* () {
    return (yield* snapshot).facets;
  });

  const getCatalogPage = Effect.fn('MerchDirectoryService.getCatalogPage')(function* (
    page: number
  ) {
    const { index } = yield* snapshot;
    const p = Math.max(1, Math.floor(page) || 1);
    const start = (p - 1) * MERCH_PAGE_SIZE;
    const result: MerchCatalogPage = {
      total: index.length,
      pageSize: MERCH_PAGE_SIZE,
      pages: Math.max(1, Math.ceil(index.length / MERCH_PAGE_SIZE)),
      page: p,
      items: index.slice(start, start + MERCH_PAGE_SIZE),
    };
    return result;
  });

  // Full lightweight index in one shot — the catalog page filters/sorts/paginates
  // client-side, which is only correct over the COMPLETE set (paginating first
  // then filtering hides matches that live on later pages). Summaries are small
  // and the payload gzips well, so this is cheaper than it looks.
  const getCatalog = Effect.fn('MerchDirectoryService.getCatalog')(function* () {
    const { index } = yield* snapshot;
    return { total: index.length, items: index };
  });

  const getProduct = Effect.fn('MerchDirectoryService.getProduct')(function* (productId: string) {
    return (yield* snapshot).details.get(productId) ?? null;
  });

  const getCorpsTeaser = Effect.fn('MerchDirectoryService.getCorpsTeaser')(function* (
    slug: string
  ) {
    return (yield* snapshot).teasers.get(slug) ?? null;
  });

  return {
    listStores,
    getFacets,
    getCatalogPage,
    getCatalog,
    getProduct,
    getCorpsTeaser,
  };
});

export class MerchDirectoryService extends Context.Service<
  MerchDirectoryService,
  Effect.Success<typeof makeMerchDirectoryService>
>()('MerchDirectoryService') {}

export const MerchDirectoryServiceLive = Layer.effect(
  MerchDirectoryService,
  makeMerchDirectoryService
);
