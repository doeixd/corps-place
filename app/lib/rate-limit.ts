/**
 * Minimal in-memory fixed-window rate limiter (Fantasy DCI plan §13 — rate-limit
 * invite acceptance + pick submission per user). Single-process, mirroring the
 * draft engine's in-memory assumption (A8/V1); a multi-process deploy would need
 * a shared store. `now` is injectable for deterministic tests.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Returns true if the call is allowed, false once `key` has hit `limit` within
 * the current `windowMs`. Each fresh window resets the count. Expired buckets are
 * recycled on access, so the map stays bounded by the active-key set.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Test/maintenance escape hatch: clear all buckets. */
export const __resetRateLimits = (): void => buckets.clear();
