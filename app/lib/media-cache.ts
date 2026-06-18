import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// Load sharp via a runtime require whose specifier is computed (not a literal),
// so Nitro's dependency tracer can't follow it and therefore does NOT copy the
// native module into `.output/server/node_modules`. That copy is the problem:
// it duplicates sharp's libvips DLL, and an in-place production rebuild can't
// overwrite that DLL while the running server holds it loaded (Windows EPERM,
// which broke a deploy). Untraced, sharp resolves from the repo's root
// node_modules at runtime instead — the prod server runs from the repo root, so
// node walks up to it. Cached after first load.
const nodeRequire = createRequire(import.meta.url);
let _sharp: typeof import('sharp') | null = null;
const getSharp = () =>
  (_sharp ??= nodeRequire(process.env.SHARP_MODULE ?? 'sharp') as typeof import('sharp'));

/**
 * Server-side image cache. The first request for a DCI asset fetches it from the
 * source and stores the bytes in a dedicated `media-cache.db`; later requests are
 * served from that copy. This keeps logos/photos working even if DCI removes the
 * originals.
 *
 * SSRF posture: a **cache hit is served regardless of host** (its bytes were
 * already vetted + stored by a trusted path — the `/api/media` first-fetch below
 * or the SDK `MediaService.cache`, which populates the *same* `media_cache`
 * table, e.g. corps-site favicons). Only **fetch-on-miss** is restricted to known
 * DCI asset hosts, so this never becomes an open proxy.
 */

const repoRoot = process.cwd();
const sdkDir = path.resolve(repoRoot, 'sdk');
const dbUrl = process.env.MEDIA_CACHE_DB_URL ?? `file:${path.resolve(sdkDir, 'media-cache.db')}`;

// DCI hosts + public merchant image CDNs (the latter suffix-matched in
// isProxiableImageHost) are the only fetch-on-miss origins — keeps this from
// being an open proxy. Cache hits are served regardless of host.
import { isProxiableImageHost } from '@/lib/media';

// Shared, long-lived client + once-per-process DDL (see event-prediction-api).
let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl }));

let tablesEnsured: Promise<void> | null = null;
const ensureTables = (db: Client) => {
  if (!tablesEnsured) {
    tablesEnsured = db
      .execute(
        `CREATE TABLE IF NOT EXISTS media_cache (
          url TEXT PRIMARY KEY,
          content_type TEXT,
          bytes BLOB,
          byte_length INTEGER,
          fetched_at TEXT
        )`
      )
      .then(() =>
        // Idempotent migrations: add columns if missing (safe to re-run).
        db
          .execute(`ALTER TABLE media_cache ADD COLUMN thumbhash TEXT`)
          .catch(() => undefined /* column already exists */)
      )
      .then(() => undefined)
      .catch((cause) => {
        tablesEnsured = null;
        throw cause;
      });
  }
  return tablesEnsured;
};

// Known no-image placeholder URL patterns — if a source URL redirects here, the
// image is gone and we must not cache the placeholder (which would permanently
// replace the last-good copy). Served from cache if a prior fetch succeeded.
const NO_IMAGE_PLACEHOLDER_PATTERNS = [
  'no-image.png',
  'no-image-available',
  'universal/images-v6/configuration/no-image',
  'no_image',
];

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value as ArrayBuffer);
};

export type CachedMedia = { contentType: string; body: Uint8Array };

/**
 * Generate a thumbhash for image bytes using sharp to decode + the thumbhash
 * package to encode. Returns null for SVGs or on any processing failure — a
 * missing thumbhash is non-fatal (the caller can still serve the image).
 */
async function generateThumbhash(body: Uint8Array, contentType: string): Promise<string | null> {
  if (contentType.includes('svg')) return null;
  try {
    const sharp = getSharp();
    const { data, info } = await sharp(body)
      .resize(100, 100, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { rgbaToThumbHash } = nodeRequire('thumbhash') as typeof import('thumbhash');
    const hash = rgbaToThumbHash(info.width, info.height, data);
    // Base64-encode the binary hash for TEXT storage.
    return Buffer.from(hash).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Return the cached thumbhash for `rawUrl`, or null if none was generated.
 */
export async function getThumbhash(rawUrl: string): Promise<string | null> {
  const db = getDb();
  await ensureTables(db);
  const row = await db.execute({
    sql: 'SELECT thumbhash FROM media_cache WHERE url = ? AND thumbhash IS NOT NULL LIMIT 1',
    args: [rawUrl],
  });
  const r = row.rows[0] as { thumbhash?: string } | undefined;
  return r?.thumbhash ?? null;
}

/**
 * Return the cached bytes for `rawUrl`, fetching + storing them on a cache miss.
 * Returns null for disallowed URLs or when the source can't be fetched and we
 * have no prior copy.
 */
export async function getOrFetchMedia(rawUrl: string): Promise<CachedMedia | null> {
  const db = getDb();
  await ensureTables(db);

  // Cache hit → serve regardless of host (bytes were already vetted at store
  // time, here or via the SDK's MediaService over the same table).
  const cached = await db.execute({
    sql: 'SELECT content_type, bytes FROM media_cache WHERE url = ? LIMIT 1',
    args: [rawUrl],
  });
  const row = cached.rows[0] as { content_type?: string; bytes?: unknown } | undefined;
  if (row?.bytes != null) {
    return {
      contentType: row.content_type ?? 'application/octet-stream',
      body: toBytes(row.bytes),
    };
  }

  // `merch-product:` keys are stable local references that should have been
  // cached during ingest. If not found, there's no live URL to fall back to.
  if (rawUrl.startsWith('merch-product:')) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // Cache miss → only fetch from allowlisted hosts (no open proxy / SSRF). Accept
  // http URLs (some storefront CDNs, e.g. Squarespace, store image URLs as http)
  // but always fetch over https — the host is allowlisted and these 301 to https
  // anyway, so this avoids a plaintext hop without dropping the image.
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    !isProxiableImageHost(parsed.host)
  )
    return null;
  const fetchUrl = parsed.protocol === 'http:' ? `https:${rawUrl.slice('http:'.length)}` : rawUrl;

  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) return null;
    // If the source redirected to a known no-image placeholder, don't cache
    // the placeholder (which would permanently replace the last-good copy).
    // If old cached bytes exist they were returned by the cache-hit check above.
    if (NO_IMAGE_PLACEHOLDER_PATTERNS.some((p) => res.url.includes(p))) return null;
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const body = new Uint8Array(await res.arrayBuffer());
    await db.execute({
      sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [rawUrl, contentType, body, body.byteLength, new Date().toISOString()],
    });
    // Best-effort thumbhash generation — a missing thumbhash is non-fatal.
    generateThumbhash(body, contentType).then((hash) => {
      if (hash) {
        db.execute({
          sql: 'UPDATE media_cache SET thumbhash = ? WHERE url = ?',
          args: [hash, rawUrl],
        }).catch(() => undefined);
      }
    });
    return { contentType, body };
  } catch {
    return null;
  }
}

// Largest width we'll generate, so a hand-edited `?w=` can't ask sharp to blow a
// small source up into a huge buffer. Sized to cover the corps cover photo at 2x
// (~448px display → ~896px), not just the small logo tiles.
const MAX_VARIANT_WIDTH = 1024;

/**
 * Like {@link getOrFetchMedia} but returns a resized WebP variant capped at
 * `width` px. The original is the heaviest cost on logo-dense pages (corps cards
 * draw 1–4 MB PNGs into a ~72px tile); a width-matched WebP is ~1–2 orders of
 * magnitude smaller. Variants are cached under a synthetic `url#w=<w>.webp` key in
 * the same `media_cache` table, so they inherit the immutable cache + the
 * cache-hit-regardless-of-host posture (a variant only exists once the original
 * was vetted + stored).
 *
 * SVGs are returned as-is (already vector + tiny). On any resize failure we fall
 * back to the original bytes so a card never breaks.
 */
export async function getOrFetchResizedMedia(
  rawUrl: string,
  width: number
): Promise<CachedMedia | null> {
  const w = Math.min(Math.max(Math.round(width), 1), MAX_VARIANT_WIDTH);
  const db = getDb();
  await ensureTables(db);

  const variantKey = `${rawUrl}#w=${w}.webp`;
  const cachedVariant = await db.execute({
    sql: 'SELECT content_type, bytes FROM media_cache WHERE url = ? LIMIT 1',
    args: [variantKey],
  });
  const vRow = cachedVariant.rows[0] as { content_type?: string; bytes?: unknown } | undefined;
  if (vRow?.bytes != null) {
    return { contentType: vRow.content_type ?? 'image/webp', body: toBytes(vRow.bytes) };
  }

  const original = await getOrFetchMedia(rawUrl);
  if (!original) return null;

  // Vector art is already tiny and resolution-independent — leave it untouched.
  if (original.contentType.includes('svg')) return original;

  try {
    const resized = await getSharp()(original.body)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const body = new Uint8Array(resized);
    await db.execute({
      sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [variantKey, 'image/webp', body, body.byteLength, new Date().toISOString()],
    });
    return { contentType: 'image/webp', body };
  } catch {
    return original;
  }
}

/**
 * A dark-mode variant of a logo: takes a logo that's "primarily dark/grey"
 * (black/grey ink — see sdk `flagDarkLogos.ts`) and recolors the ink light so it
 * reads against a dark background. Transparency is preserved (only opaque ink is
 * lit), so the mark stays its original shape on a dark page.
 *
 * Implementation: invert luminance while keeping the alpha channel — a black mark
 * becomes near-white, mid-greys flip to light-greys, the transparent surround is
 * untouched. Width-matched + WebP like {@link getOrFetchResizedMedia}, cached
 * under a distinct `url#w=<w>&dark.webp` key (inherits the same immutable-cache +
 * cache-hit posture). On any failure we fall back to the plain resized variant so
 * a logo never breaks.
 */
export async function getOrFetchDarkMedia(
  rawUrl: string,
  width: number
): Promise<CachedMedia | null> {
  const w = Math.min(Math.max(Math.round(width), 1), MAX_VARIANT_WIDTH);
  const db = getDb();
  await ensureTables(db);

  const variantKey = `${rawUrl}#w=${w}&dark.webp`;
  const cachedVariant = await db.execute({
    sql: 'SELECT content_type, bytes FROM media_cache WHERE url = ? LIMIT 1',
    args: [variantKey],
  });
  const vRow = cachedVariant.rows[0] as { content_type?: string; bytes?: unknown } | undefined;
  if (vRow?.bytes != null) {
    return { contentType: vRow.content_type ?? 'image/webp', body: toBytes(vRow.bytes) };
  }

  const original = await getOrFetchMedia(rawUrl);
  if (!original) return null;
  // SVGs aren't recolored here (they carry their own fills); serve as-is.
  if (original.contentType.includes('svg')) return original;

  try {
    const recolored = await getSharp()(original.body)
      .resize({ width: w, withoutEnlargement: true })
      .ensureAlpha()
      // Invert RGB (alpha untouched) so dark ink → light; transparency stays.
      .negate({ alpha: false })
      .webp({ quality: 80 })
      .toBuffer();
    const body = new Uint8Array(recolored);
    await db.execute({
      sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [variantKey, 'image/webp', body, body.byteLength, new Date().toISOString()],
    });
    return { contentType: 'image/webp', body };
  } catch {
    return getOrFetchResizedMedia(rawUrl, w);
  }
}
