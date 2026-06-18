import { Context, Effect, Layer } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { createClient, type Client } from '@libsql/client';
import { MediaCacheError } from './errors.js';
import { upsertMediaAsset } from './relational.js';
import type { MediaAsset } from './extraDomain.js';

/**
 * Media asset cache + registry (Effect service).
 *
 * Splits an asset into two stores, mirroring the app's existing setup:
 *  - **bytes** live in `media-cache.db` (`media_cache(url PK, content_type, bytes,
 *    byte_length, fetched_at)`) — the *same* table `app/lib/media-cache.ts` reads,
 *    so anything cached here is served by the app's `/api/media` route unchanged.
 *  - **metadata** lives in `media_assets` (in the relational db / ambient
 *    `SqlClient`): owner (corps/judge/…), role, format, dimensions, source URL,
 *    attribution, and a `metadata_json` provenance blob.
 *
 * `cache` downloads-once + registers; `serve` returns raw bytes (cache-only — no
 * live arbitrary-host proxy, so no SSRF surface); `get`/`search` query the
 * metadata registry.
 */

// Raw bytes as stored in media-cache.db.
export interface CachedMediaBytes {
  readonly url: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly fetchedAt: string;
}

export interface CacheMediaInput {
  readonly ownerType: string;
  readonly ownerId: string;
  /** Logical role for this owner: 'logo' | 'cover' | 'favicon' | … (one per role). */
  readonly role: string;
  /** Where to download the bytes from. */
  readonly sourceUrl: string;
  /** URL the app should request / bytes are keyed under. Defaults to `sourceUrl`. */
  readonly canonicalUrl?: string;
  readonly attribution?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  /** Defaults to 'image'. */
  readonly mediaType?: string;
  /** Extra provenance merged into `metadata_json` (role is always included). */
  readonly metadata?: Record<string, unknown>;
  /** Re-download even if bytes are already cached. */
  readonly refresh?: boolean;
}

export interface MediaSearchQuery {
  readonly ownerType?: string;
  readonly ownerId?: string;
  /** Matches `metadata_json.role`. */
  readonly role?: string;
  readonly format?: string;
  /** Substring match against title / description / url. */
  readonly text?: string;
  readonly limit?: number;
}

export interface ServeOptions {
  /** Override the layer's `serveFetchOnMiss` default for this call. */
  readonly fetchOnMiss?: boolean;
}

export interface MediaService {
  /** Download (once) + cache bytes and upsert the metadata row; returns the asset. */
  readonly cache: (input: CacheMediaInput) => Effect.Effect<MediaAsset, MediaCacheError, never>;
  /**
   * Raw cached bytes for a URL. On a cache miss, fetches + stores the bytes when
   * fetch-on-miss is enabled (layer config `serveFetchOnMiss`, overridable per
   * call) and the URL's host is allowed; otherwise returns null.
   */
  readonly serve: (
    url: string,
    options?: ServeOptions
  ) => Effect.Effect<CachedMediaBytes | null, MediaCacheError, never>;
  /** Metadata rows for an owner, optionally filtered to one role. */
  readonly get: (params: {
    readonly ownerType: string;
    readonly ownerId: string;
    readonly role?: string;
  }) => Effect.Effect<readonly MediaAsset[], MediaCacheError, never>;
  /** Search the metadata registry. */
  readonly search: (
    query: MediaSearchQuery
  ) => Effect.Effect<readonly MediaAsset[], MediaCacheError, never>;
}

export const MediaService = Context.Service<MediaService>('MediaService');

/* --------------------------------- helpers -------------------------------- */

const mediaIdFor = (ownerType: string, ownerId: string, role: string) =>
  `${ownerType}:${ownerId}:${role}`;

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value as ArrayBuffer);
};

// Map a content-type / URL to a short format tag (png, svg, ico, jpeg, …).
const formatFor = (contentType: string, url: string): string | undefined => {
  const ct = contentType.toLowerCase();
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpeg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('icon') || ct.includes('x-icon')) return 'ico';
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (ext === 'jpg') return 'jpeg';
  return ext || undefined;
};

// Best-effort intrinsic dimensions from image header bytes. Returns null when the
// format isn't recognized (callers treat dimensions as optional).
const imageSize = (
  bytes: Uint8Array,
  format: string | undefined
): { width: number; height: number } | null => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (format === 'png' && bytes.length >= 24) {
      // IHDR width/height at bytes 16–24 (big-endian).
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (format === 'gif' && bytes.length >= 10) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }
    if (format === 'ico' && bytes.length >= 8) {
      // First directory entry: width/height at bytes 6/7 (0 means 256).
      const w = bytes[6] || 256;
      const h = bytes[7] || 256;
      return { width: w, height: h };
    }
    if (format === 'jpeg') {
      // Walk SOFn markers for the frame dimensions.
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = bytes[off + 1];
        const len = dv.getUint16(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: dv.getUint16(off + 7), height: dv.getUint16(off + 5) };
        }
        off += 2 + len;
      }
    }
    if (format === 'svg') {
      const text = new TextDecoder().decode(bytes.subarray(0, 1024));
      const w = /\bwidth="([\d.]+)/.exec(text)?.[1];
      const h = /\bheight="([\d.]+)/.exec(text)?.[1];
      if (w && h) return { width: Math.round(+w), height: Math.round(+h) };
      const vb = /viewBox="[\d.\s]*?([\d.]+)\s+([\d.]+)"/.exec(text);
      if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
    }
  } catch {
    return null;
  }
  return null;
};

const rowToAsset = (row: Record<string, unknown>): MediaAsset => {
  const metaText = (row.metadata_json as string | null) ?? null;
  let metadata: unknown = undefined;
  if (metaText) {
    try {
      metadata = JSON.parse(metaText);
    } catch {
      metadata = metaText;
    }
  }
  return {
    mediaId: row.media_id as string,
    ownerType: row.owner_type as MediaAsset['ownerType'],
    ownerId: row.owner_id as string,
    url: row.url as string,
    title: (row.title as string | null) ?? undefined,
    description: (row.description as string | null) ?? undefined,
    mediaType: (row.media_type as string | null) ?? 'image',
    format: (row.format as string | null) ?? undefined,
    attribution: (row.attribution as string | null) ?? undefined,
    width: (row.width as number | null) ?? undefined,
    height: (row.height as number | null) ?? undefined,
    durationSeconds: (row.duration_seconds as number | null) ?? undefined,
    thumbnailUrl: (row.thumbnail_url as string | null) ?? undefined,
    sourceUrl: (row.source_url as string | null) ?? undefined,
    metadata,
  };
};

/* ---------------------------------- layer --------------------------------- */

// Hosts `serve` may fetch from on a cache miss (SSRF guard, mirrors
// app/lib/media-cache.ts). `cache` is unrestricted — it's a controlled,
// server-side populate path with an explicit source URL.
const DEFAULT_SERVE_HOSTS = ['production.assets.dci.org', 'images.dci.org'];

export interface MediaServiceConfig {
  /** libsql URL for the bytes cache. Defaults to env `MEDIA_CACHE_DB_URL` then `file:./media-cache.db`. */
  readonly cacheDbUrl?: string;
  /** Override the byte downloader (tests). Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default for `serve`: fetch + cache on a miss. Defaults to `false`. */
  readonly serveFetchOnMiss?: boolean;
  /**
   * Hosts `serve` may fetch from on a miss. Defaults to the DCI asset hosts.
   * Pass `'*'` to allow any host (use only in trusted/server contexts).
   */
  readonly allowedFetchHosts?: readonly string[] | '*';
}

export const makeMediaServiceLayer = (config: MediaServiceConfig = {}): Layer.Layer<
  MediaService,
  never,
  SqlClient.SqlClient
> =>
  Layer.effect(
    MediaService,
    Effect.gen(function* () {
      const sql = yield* (SqlClient.SqlClient);
      const cacheUrl =
        config.cacheDbUrl ?? process.env.MEDIA_CACHE_DB_URL ?? 'file:./media-cache.db';
      const doFetch = config.fetch ?? globalThis.fetch;
      const serveFetchOnMiss = config.serveFetchOnMiss ?? false;
      const allowAnyHost = config.allowedFetchHosts === '*';
      const allowedHosts = new Set(
        Array.isArray(config.allowedFetchHosts) ? config.allowedFetchHosts : DEFAULT_SERVE_HOSTS
      );
      const hostAllowed = (url: string): boolean => {
        if (allowAnyHost) return true;
        try {
          return allowedHosts.has(new URL(url).host);
        } catch {
          return false;
        }
      };
      const cacheDb: Client = createClient({ url: cacheUrl });

      const fail = (message: string, url: string, cause?: unknown) =>
        Effect.fail(new MediaCacheError({ message, url, cause }));

      // Ensure the bytes table exists (mirrors app/lib/media-cache.ts). A failure
      // here is a startup defect (bad cache DB), so die rather than surface it on
      // the layer's error channel.
      yield* (
        Effect.tryPromise({
          try: () =>
            cacheDb.execute(
              `CREATE TABLE IF NOT EXISTS media_cache (
                url TEXT PRIMARY KEY,
                content_type TEXT,
                bytes BLOB,
                byte_length INTEGER,
                fetched_at TEXT
              )`
            ),
          catch: (cause) =>
            new MediaCacheError({ message: 'failed to ensure media_cache table', url: '', cause }),
        }).pipe(Effect.orDie)
      );

      const readBytes = (url: string): Effect.Effect<CachedMediaBytes | null, MediaCacheError> =>
        Effect.tryPromise({
          try: () =>
            cacheDb.execute({
              sql: 'SELECT content_type, bytes, byte_length, fetched_at FROM media_cache WHERE url = ? LIMIT 1',
              args: [url],
            }),
          catch: (cause) =>
            new MediaCacheError({ message: `media_cache read failed for ${url}`, url, cause }),
        }).pipe(
          Effect.map((result) => {
            const row = result.rows[0] as
              | { content_type?: string; bytes?: unknown; byte_length?: number; fetched_at?: string }
              | undefined;
            if (!row || row.bytes == null) return null;
            const bytes = toBytes(row.bytes);
            return {
              url,
              contentType: row.content_type ?? 'application/octet-stream',
              bytes,
              byteLength: row.byte_length ?? bytes.byteLength,
              fetchedAt: row.fetched_at ?? '',
            };
          })
        );

      const writeBytes = (
        url: string,
        contentType: string,
        bytes: Uint8Array,
        fetchedAt: string
      ): Effect.Effect<void, MediaCacheError> =>
        Effect.tryPromise({
          try: () =>
            cacheDb.execute({
              sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [url, contentType, bytes, bytes.byteLength, fetchedAt],
            }),
          catch: (cause) =>
            new MediaCacheError({ message: `media_cache write failed for ${url}`, url, cause }),
        }).pipe(Effect.asVoid);

      const download = (url: string): Effect.Effect<{ contentType: string; bytes: Uint8Array }, MediaCacheError> =>
        Effect.tryPromise({
          try: () => doFetch(url),
          catch: (cause) => new MediaCacheError({ message: `fetch failed for ${url}`, url, cause }),
        }).pipe(
          Effect.flatMap((res) =>
            res.ok
              ? Effect.tryPromise({
                  try: async () => ({
                    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
                    bytes: new Uint8Array(await res.arrayBuffer()),
                  }),
                  catch: (cause) =>
                    new MediaCacheError({ message: `reading body failed for ${url}`, url, cause }),
                })
              : fail(`HTTP ${res.status} for ${url}`, url)
          )
        );

      const cache: MediaService['cache'] = (input) =>
        Effect.gen(function* () {
          const canonical = input.canonicalUrl ?? input.sourceUrl;

          // Reuse cached bytes unless a refresh is requested.
          const existing = input.refresh ? null : yield* (readBytes(canonical));
          const fetchedAt = existing?.fetchedAt || new Date().toISOString();
          let contentType: string;
          let bytes: Uint8Array;
          if (existing) {
            contentType = existing.contentType;
            bytes = existing.bytes;
          } else {
            const dl = yield* (download(input.sourceUrl));
            contentType = dl.contentType;
            bytes = dl.bytes;
            yield* (writeBytes(canonical, contentType, bytes, fetchedAt));
          }

          const format = formatFor(contentType, canonical);
          const dims = imageSize(bytes, format);
          const asset: MediaAsset = {
            mediaId: mediaIdFor(input.ownerType, input.ownerId, input.role),
            ownerType: input.ownerType as MediaAsset['ownerType'],
            ownerId: input.ownerId,
            url: canonical,
            title: input.title ?? undefined,
            description: input.description ?? undefined,
            mediaType: input.mediaType ?? 'image',
            format,
            attribution: input.attribution ?? undefined,
            width: dims?.width,
            height: dims?.height,
            durationSeconds: undefined,
            thumbnailUrl: undefined,
            sourceUrl: input.sourceUrl,
            metadata: {
              role: input.role,
              contentType,
              byteLength: bytes.byteLength,
              fetchedAt,
              ...input.metadata,
            },
          };

          yield* (
            upsertMediaAsset(sql, asset).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.mapError(
                (cause) =>
                  new MediaCacheError({
                    message: `media_assets upsert failed for ${asset.mediaId}`,
                    url: canonical,
                    cause,
                  })
              )
            )
          );
          return asset;
        });

      const serve: MediaService['serve'] = (url, options) =>
        Effect.gen(function* () {
          const cached = yield* (readBytes(url));
          if (cached) return cached;

          const fetchOnMiss = options?.fetchOnMiss ?? serveFetchOnMiss;
          if (!fetchOnMiss || !hostAllowed(url)) return null;

          // Cache miss + fetch-on-miss allowed: download, store bytes, return.
          const dl = yield* (download(url));
          const fetchedAt = new Date().toISOString();
          yield* (writeBytes(url, dl.contentType, dl.bytes, fetchedAt));
          return {
            url,
            contentType: dl.contentType,
            bytes: dl.bytes,
            byteLength: dl.bytes.byteLength,
            fetchedAt,
          };
        });

      const get: MediaService['get'] = (params) =>
        sql<Record<string, unknown>>`
          SELECT * FROM media_assets
          WHERE owner_type = ${params.ownerType} AND owner_id = ${params.ownerId}
          ${params.role ? sql`AND json_extract(metadata_json, '$.role') = ${params.role}` : sql``}
          ORDER BY media_id
        `.pipe(
          Effect.map((rows) => rows.map(rowToAsset)),
          Effect.mapError(
            (cause) =>
              new MediaCacheError({ message: 'media_assets get failed', url: '', cause })
          ),
          Effect.provideService(SqlClient.SqlClient, sql)
        );

      const search: MediaService['search'] = (query) => {
        const like = query.text ? `%${query.text}%` : null;
        return sql<Record<string, unknown>>`
          SELECT * FROM media_assets
          WHERE 1 = 1
          ${query.ownerType ? sql`AND owner_type = ${query.ownerType}` : sql``}
          ${query.ownerId ? sql`AND owner_id = ${query.ownerId}` : sql``}
          ${query.format ? sql`AND format = ${query.format}` : sql``}
          ${query.role ? sql`AND json_extract(metadata_json, '$.role') = ${query.role}` : sql``}
          ${like ? sql`AND (url LIKE ${like} OR title LIKE ${like} OR description LIKE ${like})` : sql``}
          ORDER BY media_id
          LIMIT ${query.limit ?? 100}
        `.pipe(
          Effect.map((rows) => rows.map(rowToAsset)),
          Effect.mapError(
            (cause) =>
              new MediaCacheError({ message: 'media_assets search failed', url: '', cause })
          ),
          Effect.provideService(SqlClient.SqlClient, sql)
        );
      };

      return { cache, serve, get, search };
    })
  );

/** Default layer: bytes in `./media-cache.db`, metadata via the ambient SqlClient. */
export const MediaServiceLive = makeMediaServiceLayer();
