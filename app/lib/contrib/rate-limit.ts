import type { Client } from '@libsql/client';
import type { Actor } from '@/lib/authz';

/**
 * Spam/abuse rate limiting for base-`user` contributions (Show Detail Wiki, M9).
 *
 * Editing is the default capability, so the throttle is the first line of defense
 * against a single account flooding writes. `trusted`+ are exempt (the §6.2
 * spam-resistance tier). The ledger lives in `contrib_rate_events`; we count
 * events in a sliding window and reject when over the cap, recording the event
 * only on success so a rejected attempt doesn't extend its own window.
 */

export class RateLimitError extends Error {
  readonly _tag = 'RateLimitError';
  constructor(
    public readonly action: string,
    public readonly retryAfterMs: number
  ) {
    super(`Rate limit reached for ${action}. Try again in a moment.`);
  }
}

export type RateLimitedAction = 'edit' | 'upload';

// Per-action sliding window (count within windowMs). Generous for a real
// contributor, tight enough to blunt a flood.
const LIMITS: Record<RateLimitedAction, { max: number; windowMs: number }> = {
  edit: { max: 40, windowMs: 10 * 60_000 }, // 40 edits / 10 min
  upload: { max: 15, windowMs: 10 * 60_000 }, // 15 uploads / 10 min
};

const EXEMPT_ROLES = new Set(['trusted', 'moderator', 'admin']);

/**
 * Throw RateLimitError when `actor` has exceeded the window for `action`; record
 * the event otherwise. `trusted`+ skip the check entirely. `now` is injectable
 * for tests. Best-effort prune of expired rows keeps the ledger small.
 */
export const enforceRateLimit = async (
  db: Client,
  actor: Actor,
  action: RateLimitedAction,
  now: number = Date.now()
): Promise<void> => {
  if (EXEMPT_ROLES.has(actor.role)) return;
  const { max, windowMs } = LIMITS[action];
  const since = new Date(now - windowMs).toISOString();

  const res = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM contrib_rate_events WHERE user_id = ? AND action = ? AND created_at >= ?',
    args: [actor.userId, action, since],
  });
  const count = Number((res.rows[0] as unknown as { n: number }).n ?? 0);
  if (count >= max) throw new RateLimitError(action, windowMs);

  await db.execute({
    sql: 'INSERT INTO contrib_rate_events (event_id, user_id, action, created_at) VALUES (?, ?, ?, ?)',
    args: [crypto.randomUUID(), actor.userId, action, new Date(now).toISOString()],
  });
  // Opportunistic prune (cheap, indexed) so the ledger never grows unbounded.
  await db.execute({
    sql: 'DELETE FROM contrib_rate_events WHERE user_id = ? AND action = ? AND created_at < ?',
    args: [actor.userId, action, since],
  });
};
