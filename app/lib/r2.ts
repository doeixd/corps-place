import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * R2 access for user-uploaded show media (M5). Reuses the SAME bucket + credentials
 * the app already uses for the read-model (endpoint derived from RESTIC_REPOSITORY
 * when R2_ENDPOINT isn't set — mirrors sdk/src/dataSync.ts so no new secrets are
 * needed). Uploads live under their own top-level `uploads/` prefix, clear of the
 * read-model's `corps-data/` and restic's repo dirs.
 */

const UPLOAD_PREFIX = (process.env.R2_UPLOAD_PREFIX || 'uploads').replace(/\/+$/, '');

const endpoint = (): string => {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const m = (process.env.RESTIC_REPOSITORY ?? '').match(/^s3:(https?:\/\/[^/]+)/);
  if (m) return m[1];
  throw new Error('R2_ENDPOINT not set and not derivable from RESTIC_REPOSITORY');
};
const bucket = (): string => process.env.R2_BUCKET || 'corps-place';

let _client: S3Client | null = null;
const client = (): S3Client =>
  (_client ??= new S3Client({
    region: 'auto',
    endpoint: endpoint(),
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    },
  }));

/** Full object key for an upload (callers pass the relative part). */
export const uploadKey = (rel: string): string => `${UPLOAD_PREFIX}/${rel.replace(/^\/+/, '')}`;

export const putUpload = async (
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> => {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
};

export const getUpload = async (
  key: string
): Promise<{ body: Uint8Array; contentType: string } | null> => {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const body = await res.Body!.transformToByteArray();
    return { body, contentType: res.ContentType ?? 'application/octet-stream' };
  } catch {
    return null;
  }
};

/** Guard: only serve/accept keys under our upload prefix (no arbitrary bucket reads). */
export const isUploadKey = (key: string): boolean => key.startsWith(`${UPLOAD_PREFIX}/`);
