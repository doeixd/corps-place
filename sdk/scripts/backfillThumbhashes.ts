#!/usr/bin/env node
// Backfill missing thumbhashes for cached product images in media-cache.db.
// For each product image without a thumbhash, decodes the cached image bytes
// with sharp, generates a thumbhash, and writes it back.
//
// Usage (from sdk/):
//   npx tsx scripts/backfillThumbhashes.ts [--limit N]
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadRepoEnv } from "./scriptEnv.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const sharp = require("sharp");
const { rgbaToThumbHash } = require("thumbhash");

const DB_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const db = createClient({ url: DB_URL });
const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : undefined;

async function main() {
  const where = "url LIKE 'merch-product:%' AND thumbhash IS NULL" + (limit ? ` LIMIT ${limit}` : "");
  const rows = (await db.execute({
    sql: `SELECT url, content_type, bytes FROM media_cache WHERE ${where}`, args: [],
  })).rows as any[];

  console.log(`[backfill-thumbhash] processing ${rows.length} product images...`);
  let count = 0;
  for (const row of rows) {
    try {
      if (!row.bytes) continue;
      // sharp needs to know the format for raw buffers
      const fmt = (row.content_type || "").includes("png") ? "png"
        : (row.content_type || "").includes("webp") ? "webp" : "jpeg";
      const { data, info } = await sharp(row.bytes)
        .ensureAlpha()
        .resize(100, 100, { fit: "inside" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const hash = Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString("base64");
      await db.execute({
        sql: "UPDATE media_cache SET thumbhash = ? WHERE url = ?",
        args: [hash, row.url],
      });
      count++;
      if (count % 500 === 0) console.log(`[backfill-thumbhash] ${count} / ${rows.length}`);
    } catch (e: any) {
      // Some images may be corrupt — skip and continue
    }
  }
  console.log(`[backfill-thumbhash] done — ${count} thumbhashes generated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
