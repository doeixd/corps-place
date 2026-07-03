/**
 * Admin operational-alert push subscriptions. Lets an admin register THIS device
 * (from /admin/jobs) to receive Web Push when a cron job fails — e.g. the score
 * auto-ingest. Reuses the existing VAPID + service-worker infra; the sender is the
 * VM-side scripts/recordIngestRun.ts on the failure path. Device-based (keyed by
 * endpoint) like score_push_subscriptions. Cap: viewAdmin (moderators+).
 */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';
import { vapidPublicKey } from '@/lib/fantasy/push';

/** VAPID public key the client needs to subscribe (null when push is off). */
export const getAdminVapidPublicKey = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getRequest(), 'viewAdmin');
  return { publicKey: vapidPublicKey() };
});

const PushSubInput = v.object({
  endpoint: v.pipe(v.string(), v.url()),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

/** Register (or refresh) this device for admin alerts. Cap: viewAdmin. */
export const saveAdminPushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(PushSubInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT INTO admin_push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
              user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      args: [
        data.endpoint,
        actor.userId,
        data.keys.p256dh,
        data.keys.auth,
        new Date().toISOString(),
      ],
    });
    return { ok: true as const };
  });

/** Unregister this device from admin alerts. Cap: viewAdmin. */
export const deleteAdminPushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ endpoint: v.string() }), d))
  .handler(async ({ data }) => {
    await requireCapability(getRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    await db.execute({
      sql: 'DELETE FROM admin_push_subscriptions WHERE endpoint = ?',
      args: [data.endpoint],
    });
    return { ok: true as const };
  });
