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

/** Send a push to every device a user has subscribed; prune dead subscriptions. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const keys = vapid();
  if (!keys) {
    console.warn(`[push] VAPID keys not set — push to ${userId} skipped: ${payload.title}`);
    return;
  }
  const db = await getContributionsDb();
  const subs = (
    await db.execute({
      sql: 'SELECT endpoint, p256dh, auth FROM fantasy_push_subscriptions WHERE user_id = ?',
      args: [userId],
    })
  ).rows;
  if (subs.length === 0) return;

  const mod = await import('web-push');
  const webpush = mod.default;
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const data = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      const endpoint = s.endpoint as string;
      try {
        await webpush.sendNotification(
          { endpoint, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
          data
        );
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await db.execute({
            sql: 'DELETE FROM fantasy_push_subscriptions WHERE user_id = ? AND endpoint = ?',
            args: [userId, endpoint],
          });
        }
      }
    })
  );
}
