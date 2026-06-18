// Backfill thumbhash for every cached image in media-cache.db that doesn't
// already have one. Uses sharp to decode → raw RGBA, thumbhash to encode,
// writes back. Skippable: SVGs (can't rasterize) and already-hashed rows.
//
// Usage: npx tsx scripts/generateThumbhashes.ts [--db path/to/media-cache.db] [--concurrency N]
// Default concurrency: 4

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { createClient } from '@libsql/client';

const nodeRequire = createRequire(import.meta.url);

const repoRoot = path.resolve(import.meta.dirname, '..');
const getSharp = () =>
  nodeRequire(path.resolve(repoRoot, 'node_modules', 'sharp')) as typeof import('sharp');
const getThumbhash = () =>
  nodeRequire(path.resolve(repoRoot, 'node_modules', 'thumbhash')) as typeof import('thumbhash');

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
};
const concurrency = Math.max(1, Number(getArg('--concurrency') ?? '4'));

async function main() {
  const dbPath_ = getArg('--db') ?? path.resolve(repoRoot, 'sdk', 'media-cache.db');
  console.log(`Opening ${dbPath_} …`);
  const db = createClient({ url: `file:${dbPath_}` });

  // Ensure the column exists (idempotent).
  try {
    await db.execute('ALTER TABLE media_cache ADD COLUMN thumbhash TEXT');
  } catch {
    // column already exists
  }

  const result = await db.execute(
    `SELECT url, content_type, bytes FROM media_cache
     WHERE thumbhash IS NULL AND content_type NOT LIKE '%svg%'`
  );
  const rows = result.rows.map((r) => ({
    url: r.url as string,
    content_type: r.content_type as string,
    bytes: r.bytes as ArrayBuffer,
  }));
  console.log(`${rows.length} images without thumbhash`);
  if (rows.length === 0) {
    db.close();
    return;
  }

  const sharp = getSharp();
  const { rgbaToThumbHash } = getThumbhash();

  let done = 0;
  let skipped = 0;
  let failed = 0;

  const processRow = async (row: (typeof rows)[number]) => {
    try {
      const { data, info } = await sharp(Buffer.from(row.bytes))
        .resize(100, 100, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const hash = rgbaToThumbHash(info.width, info.height, data);
      await db.execute({
        sql: 'UPDATE media_cache SET thumbhash = ? WHERE url = ?',
        args: [Buffer.from(hash).toString('base64'), row.url],
      });
      done++;
    } catch (e) {
      if (String(e).includes('unsupported image format') || String(e).includes('corrupt')) {
        skipped++;
      } else {
        failed++;
        console.error(`  FAIL ${row.url}: ${String(e).slice(0, 120)}`);
      }
    }
  };

  // Simple concurrency limiter.
  const queue = [...rows];
  async function worker() {
    while (queue.length > 0) {
      const row = queue.shift()!;
      await processRow(row);
      if ((done + skipped + failed) % 100 === 0) {
        console.log(
          `  progress: ${done} hashed, ${skipped} skipped, ${failed} failed, ${queue.length} remaining`
        );
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`Done. ${done} hashed, ${skipped} skipped, ${failed} failed`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
