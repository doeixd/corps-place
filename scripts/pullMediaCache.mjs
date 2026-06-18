// Standalone, dependency-light media-cache pull for the PRODUCTION runtime image.
//
// Plain ESM (no tsx, no @sdk TypeScript) so it runs under the pruned production
// node_modules — it only needs @aws-sdk/client-s3 (a root dependency) and Node
// built-ins. The richer sdk/src/dataSync.ts is for the dev/ingest side.
//
// Invoked by docker-entrypoint.sh before the server starts. STRICTLY best-effort:
// any failure logs and exits 0 so the app still boots on whatever is already in
// /data (the on-disk fallback).
//
// Not slotted (no A/B swap) — we just download and overwrite the media-cache DB.
// Configure via the same env the app uses:
//   MEDIA_CACHE_DB_URL=file:/data/media-cache.db
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//   R2_ENDPOINT (or RESTIC_REPOSITORY), R2_BUCKET (default corps-place),
//   R2_PREFIX (default corps-data)
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

const log = (m) => console.log(`[pull-media-cache] ${m}`);

const endpoint = () => {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const m = (process.env.RESTIC_REPOSITORY ?? '').match(/^s3:(https?:\/\/[^/]+)/);
  if (m) return m[1];
  throw new Error('R2_ENDPOINT not set and not derivable from RESTIC_REPOSITORY');
};
const bucket = () => process.env.R2_BUCKET || 'corps-place';
const prefix = () => (process.env.R2_PREFIX || 'corps-data').replace(/\/+$/, '');
const basePath = () =>
  (process.env.MEDIA_CACHE_DB_URL || 'file:/data/media-cache.db').replace(/^file:/, '');

const sha256File = async (p) => {
  const h = createHash('sha256');
  await pipeline(createReadStream(p), h);
  return h.digest('hex');
};

const rmFiles = (p) => {
  for (const ext of ['', '-wal', '-shm', '-info', '-client_wal_index']) {
    try {
      fs.rmSync(p + ext, { force: true });
    } catch {}
  }
};

const main = async () => {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    log('no R2 credentials in env — skipping (serving on-disk media-cache)');
    return;
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: endpoint(),
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = bucket();
  const key = `${prefix()}/media-cache/media-cache.db`;
  const manifestKey = `${prefix()}/media-cache/manifest.json`;

  let manifest = null;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket, Key: manifestKey }));
    manifest = JSON.parse(await res.Body.transformToString());
  } catch {
    log('no manifest in bucket — skipping (serving on-disk media-cache)');
    return;
  }

  const base = basePath();
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const tmp = `${base}.download.tmp`;
  rmFiles(tmp);

  log(`downloading s3://${Bucket}/${key} (${manifest.bytes} bytes)…`);
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  await pipeline(res.Body, createWriteStream(tmp));

  const got = await sha256File(tmp);
  if (manifest.sha256 && got !== manifest.sha256) {
    rmFiles(tmp);
    throw new Error(`checksum mismatch (expected ${manifest.sha256}, got ${got})`);
  }

  // Non-slotted overwrite: replace the live file (same as downloadDataset for slots=false).
  rmFiles(base);
  fs.renameSync(tmp, base);
  log(`done (${manifest.bytes} bytes, sha256 ${manifest.sha256.slice(0, 12)}…)`);
};

main().catch((err) => {
  // Best-effort: never block boot. Log and exit 0 so the app serves whatever is
  // already on disk.
  console.error(`[pull-media-cache] skipped: ${err?.message ?? err}`);
  process.exit(0);
});
