/**
 * Web Push delivery (Fantasy DCI plan §8.2 / M5). SERVER-ONLY.
 *
 * Mirrors the email helper's posture: if VAPID keys aren't configured we log and
 * no-op, so the feature degrades cleanly. Subscriptions live in
 * `fantasy_push_subscriptions`; a gone subscription (404/410) is pruned on send.
 */
import { getContributionsDb } from '@/lib/contributions-db';

type Vapid = { publicKey: string; privateKey: string; subject: string };

const vapid = (): Vapid | null => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT ?? 'mailto:login@drumcorps.app',
  };
};

/** Is push configured (VAPID keys present)? Surfaced to the client subscribe UI. */
export const pushConfigured = (): boolean => vapid() !== null;
export const vapidPublicKey = (): string | null => vapid()?.publicKey ?? null;

export type PushPayload = { title: string; body: string; url?: string };

/**
 * Result of a push attempt. `subscriptions` is how many devices the user had;
 * `delivered` is how many accepted the push. Callers that need at-least-once
 * semantics (the standings digest) treat `subscriptions > 0 && delivered === 0`
 * as a transient failure worth retrying, and anything else as settled (nothing to
 * deliver, or delivered). `vapidDisabled` means push isn't configured at all.
 */
export type PushResult = { subscriptions: number; delivered: number; vapidDisabled?: boolean };

/** Send a push to every device a user has subscribed; prune dead subscriptions. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  const keys = vapid();
  if (!keys) {
    console.warn(`[push] VAPID keys not set — push to ${userId} skipped: ${payload.title}`);
    return { subscriptions: 0, delivered: 0, vapidDisabled: true };
  }
  const db = await getContributionsDb();
  const subs = (
    await db.execute({
      sql: 'SELECT endpoint, p256dh, auth FROM fantasy_push_subscriptions WHERE user_id = ?',
      args: [userId],
    })
  ).rows;
  if (subs.length === 0) return { subscriptions: 0, delivered: 0 };

  const mod = await import('web-push');
  const webpush = mod.default;
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const data = JSON.stringify(payload);

  const results = await Promise.all(
    subs.map(async (s) => {
      const endpoint = s.endpoint as string;
      try {
        await webpush.sendNotification(
          { endpoint, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
          data
        );
        return true;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await db.execute({
            sql: 'DELETE FROM fantasy_push_subscriptions WHERE user_id = ? AND endpoint = ?',
            args: [userId, endpoint],
          });
        }
        return false;
      }
    })
  );
  return { subscriptions: subs.length, delivered: results.filter(Boolean).length };
}
