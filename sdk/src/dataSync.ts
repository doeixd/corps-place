// R2 (S3-compatible) push/pull for the project's data artifacts — the
// replacement for the Turso read-model sync. Each artifact is a single,
// read-only, batch-built SQLite file, so this is plain object storage (upload +
// download + checksum), NOT live replication.
//
// Reuses the Cloudflare R2 bucket already configured for backups:
//   R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
//   R2_BUCKET            bucket name (created on first push if missing)
//   AWS_ACCESS_KEY_ID    R2 S3-API access key id
//   AWS_SECRET_ACCESS_KEY R2 S3-API secret
//
// Layout per dataset under the bucket:
//   <name>/<file>          the latest artifact (e.g. read-model/read-model.db)
//   <name>/manifest.json   { sha256, bytes, gitSha, uploadedAt, file }

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";

// ── Dataset registry ─────────────────────────────────────────────────────────
// Local paths resolve from the same env vars the app/services use, so a pull on
// the prod box (READ_MODEL_DB_URL=file:/data/read-model.db) lands in /data and a
// dev pull lands under sdk/. `slots` marks the read-model, which the puller
// installs into the inactive A/B slot + flips the `.active` pointer (zero-downtime
// hot-swap, mirroring app/lib/read-model-db.ts).
export type DatasetName = "read-model" | "relational" | "media-cache";

const stripFile = (v: string | undefined, fallback: string): string =>
  (v ? v.replace(/^file:/, "") : fallback);

export interface Dataset {
  name: DatasetName;
  /** Absolute/relative local path to the canonical (base) file. */
  localPath: string;
  /** Remote object key for the latest artifact. */
  remoteKey: string;
  /** A/B slot + pointer hot-swap install on pull (read-model only). */
  slots: boolean;
}

export const DATASETS: Record<DatasetName, Dataset> = {
  "read-model": {
    name: "read-model",
    localPath: stripFile(process.env.READ_MODEL_DB_URL, "./read-model.db"),
    remoteKey: "read-model/read-model.db",
    slots: true,
  },
  relational: {
    name: "relational",
    localPath: stripFile(process.env.DCI_RELATIONAL_DB_URL, "./dci-relational.db"),
    remoteKey: "relational/dci-relational.db",
    slots: false,
  },
  "media-cache": {
    name: "media-cache",
    localPath: stripFile(process.env.MEDIA_CACHE_DB_URL, "./media-cache.db"),
    remoteKey: "media-cache/media-cache.db",
    slots: false,
  },
};

export const ALL_DATASETS = Object.keys(DATASETS) as DatasetName[];

export const resolveDatasets = (args: readonly string[]): DatasetName[] => {
  const names = args.filter((a) => !a.startsWith("-"));
  if (names.length === 0 || names.includes("all")) return ALL_DATASETS;
  const out: DatasetName[] = [];
  for (const n of names) {
    if (n in DATASETS) out.push(n as DatasetName);
    else throw new Error(`unknown dataset "${n}" (expected: ${ALL_DATASETS.join(", ")}, all)`);
  }
  return out;
};

// ── Manifest ─────────────────────────────────────────────────────────────────
export interface Manifest {
  sha256: string;
  bytes: number;
  gitSha: string;
  uploadedAt: string;
  file: string;
}

const manifestKey = (ds: Dataset) => prefixed(`${ds.name}/manifest.json`);

const gitSha = (): string => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

export const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
};

// ── Client ───────────────────────────────────────────────────────────────────
const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (load it from .env before running)`);
  return v;
};

// Endpoint: explicit R2_ENDPOINT wins; otherwise derive it from the existing
// RESTIC_REPOSITORY (`s3:https://<account>.r2.cloudflarestorage.com/<repo>`), so
// no new secrets need to live in the root .env (which is root-owned here).
const endpoint = (): string => {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const restic = process.env.RESTIC_REPOSITORY ?? "";
  const m = restic.match(/^s3:(https?:\/\/[^/]+)/);
  if (m) return m[1];
  throw new Error("R2_ENDPOINT is not set and could not be derived from RESTIC_REPOSITORY");
};

// Bucket: reuse the existing R2 bucket the credentials are scoped to (the same
// one restic backs up to). Override with R2_BUCKET.
const bucket = (): string => process.env.R2_BUCKET || "corps-place";

// Key prefix: keep artifacts under their own top-level prefix so they never
// interleave with restic's repo structure (config, data/, index/, keys/,
// snapshots/, locks/) in the shared bucket. Override with R2_PREFIX.
const prefix = (): string => (process.env.R2_PREFIX || "corps-data").replace(/\/+$/, "");
const prefixed = (key: string): string => `${prefix()}/${key}`;

let _client: S3Client | null = null;
const client = (): S3Client =>
  (_client ??= new S3Client({
    region: "auto",
    endpoint: endpoint(),
    forcePathStyle: true,
    // R2 doesn't implement the AWS SDK's default integrity checksum headers
    // (x-amz-checksum-*). We verify with our own SHA-256, so only send/validate
    // them when explicitly required (i.e. never here).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: required("AWS_ACCESS_KEY_ID"),
      secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    },
  }));

const ensureBucket = async (): Promise<void> => {
  const Bucket = bucket();
  try {
    await client().send(new HeadBucketCommand({ Bucket }));
  } catch {
    // Bucket-scoped credentials often can't create buckets. Try, but if that's
    // also refused, proceed — the bucket may exist with Head denied, and the
    // subsequent PutObject surfaces a real permission error if it doesn't.
    try {
      await client().send(new CreateBucketCommand({ Bucket }));
    } catch {
      /* assume it exists; upload will fail loudly otherwise */
    }
  }
};

// ── Upload / download ────────────────────────────────────────────────────────
export const uploadDataset = async (
  ds: Dataset,
  log: (m: string) => void = console.error,
): Promise<Manifest> => {
  // For the read-model, push the live (active-slot) file; the base path may not
  // exist when only the A/B slots do.
  const src = ds.slots ? resolveActiveSlot(ds.localPath) : ds.localPath;
  if (!fs.existsSync(src)) throw new Error(`${ds.name}: local file not found at ${src}`);

  await ensureBucket();
  const bytes = fs.statSync(src).size;
  log(`${ds.name}: hashing ${src} (${fmtBytes(bytes)})…`);
  const sha256 = await sha256File(src);

  log(`${ds.name}: uploading → s3://${bucket()}/${prefixed(ds.remoteKey)}`);
  const upload = new Upload({
    client: client(),
    params: {
      Bucket: bucket(),
      Key: prefixed(ds.remoteKey),
      Body: createReadStream(src),
      Metadata: { sha256 },
    },
    queueSize: 4,
    partSize: 64 * 1024 * 1024, // 64 MiB parts → handles multi-GB files
  });
  upload.on("httpUploadProgress", (p) => {
    if (p.loaded && p.total) log(`  ${ds.name}: ${fmtBytes(p.loaded)}/${fmtBytes(p.total)}`);
  });
  await upload.done();

  const manifest: Manifest = {
    sha256,
    bytes,
    gitSha: gitSha(),
    uploadedAt: new Date().toISOString(),
    file: path.basename(ds.remoteKey),
  };
  await putJson(manifestKey(ds), manifest);
  log(`${ds.name}: done (sha256 ${sha256.slice(0, 12)}…, git ${manifest.gitSha})`);
  return manifest;
};

export const downloadDataset = async (
  ds: Dataset,
  log: (m: string) => void = console.error,
): Promise<Manifest> => {
  const manifest = await getJson<Manifest>(manifestKey(ds));
  if (!manifest) throw new Error(`${ds.name}: no manifest in bucket — has it been pushed?`);

  // Stream into a temp file alongside the destination, verify, then install.
  const destBase = ds.localPath;
  fs.mkdirSync(path.dirname(path.resolve(destBase)), { recursive: true });
  const tmp = `${destBase}.download.tmp`;
  rmFiles(tmp);

  log(`${ds.name}: downloading s3://${bucket()}/${prefixed(ds.remoteKey)} (${fmtBytes(manifest.bytes)})…`);
  const res = await client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: prefixed(ds.remoteKey) }),
  );
  if (!res.Body) throw new Error(`${ds.name}: empty response body`);
  await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(tmp));

  log(`${ds.name}: verifying checksum…`);
  const got = await sha256File(tmp);
  if (got !== manifest.sha256) {
    rmFiles(tmp);
    throw new Error(`${ds.name}: checksum mismatch (expected ${manifest.sha256}, got ${got})`);
  }

  if (ds.slots) installIntoInactiveSlot(destBase, tmp, log);
  else {
    rmFiles(destBase);
    fs.renameSync(tmp, destBase);
    log(`${ds.name}: installed → ${destBase}`);
  }
  return manifest;
};

// ── A/B slot helpers (mirror app/lib/read-model-db.ts) ───────────────────────
const slotPaths = (baseFilePath: string) => {
  const dir = path.dirname(baseFilePath);
  const stem = path.basename(baseFilePath).replace(/\.db$/i, "");
  return {
    dir,
    pointer: path.join(dir, `${stem}.active`),
    a: path.join(dir, `${stem}.a.db`),
    b: path.join(dir, `${stem}.b.db`),
  };
};

const resolveActiveSlot = (baseFilePath: string): string => {
  const s = slotPaths(baseFilePath);
  try {
    const slot = fs.readFileSync(s.pointer, "utf8").trim();
    if (slot === "a" && fs.existsSync(s.a)) return s.a;
    if (slot === "b" && fs.existsSync(s.b)) return s.b;
  } catch {
    /* no pointer — fall back below */
  }
  if (fs.existsSync(baseFilePath)) return baseFilePath;
  if (fs.existsSync(s.a)) return s.a;
  if (fs.existsSync(s.b)) return s.b;
  return baseFilePath; // let the caller's existence check report the miss
};

// Install the downloaded file into the *inactive* slot, then flip the pointer
// last (tiny atomic rename) so a running server hot-swaps with no downtime.
const installIntoInactiveSlot = (
  baseFilePath: string,
  tmpFile: string,
  log: (m: string) => void,
) => {
  const s = slotPaths(baseFilePath);
  let active: "a" | "b" | null = null;
  try {
    const v = fs.readFileSync(s.pointer, "utf8").trim();
    if (v === "a" || v === "b") active = v;
  } catch {
    /* none yet */
  }
  const target: "a" | "b" = active === "a" ? "b" : "a";
  const targetFile = target === "a" ? s.a : s.b;

  rmFiles(targetFile); // clear prior generation incl. WAL/SHM sidecars
  fs.renameSync(tmpFile, targetFile);

  const ptrTmp = `${s.pointer}.tmp`;
  fs.writeFileSync(ptrTmp, target);
  fs.renameSync(ptrTmp, s.pointer); // atomic flip — the moment it goes live
  log(`read-model: installed → slot ${target} (${targetFile}); pointer flipped`);
};

// ── small utils ──────────────────────────────────────────────────────────────
const rmFiles = (filePath: string) => {
  for (const ext of ["", "-wal", "-shm", "-info", "-client_wal_index"]) {
    try {
      fs.rmSync(filePath + ext, { force: true });
    } catch {
      /* best-effort */
    }
  }
};

const putJson = async (key: string, obj: unknown): Promise<void> => {
  await client().send(
    new (await import("@aws-sdk/client-s3")).PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(obj, null, 2),
      ContentType: "application/json",
    }),
  );
};

const getJson = async <T>(key: string): Promise<T | null> => {
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
};

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
};
