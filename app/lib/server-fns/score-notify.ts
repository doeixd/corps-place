import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';
import { vapidPublicKey } from '@/lib/fantasy/push';
import { recordServerEvent } from '@/lib/analytics/record';

/**
 * "Notify me of scores" subscriptions. Anyone — signed in or not — can subscribe
 * by email to be emailed when scores post for an event or a corps. The unique
 * index (target_kind, target_slug, email) dedupes repeat subscriptions; we use
 * INSERT OR IGNORE so a resubscribe is a quiet no-op.
 *
 * DB access happens ONLY inside handler bodies (no module-scope DB client) so the
 * server chain (contributions-db / libsql / node:*) is stripped from the client
 * bundle. See memory fantasy-jobs-deploy-bundle-leak.
 */

const Methods = v.object({
  email: v.optional(v.boolean(), true),
  push: v.optional(v.boolean(), false),
});

const SubscribeInput = v.object({
  targetKind: v.picklist(['event', 'corps']),
  targetSlug: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  targetLabel: v.optional(v.string()),
  email: v.pipe(v.string(), v.email()),
  methods: v.optional(Methods),
});

const UnsubscribeInput = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
});

const PushSubInput = v.object({
  endpoint: v.pipe(v.string(), v.url()),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
  email: v.optional(v.string()),
});

export const subscribeScores = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SubscribeInput, d))
  .handler(async ({ data }): Promise<{ ok: true; token: string | null }> => {
    const email = data.email.trim().toLowerCase();

    // Anti-abuse throttle keyed by email (covers signed-out subscribers too).
    if (!rateLimit(`score-notify:subscribe:${email}`, 20, 60_000))
      throw new Error('Too many requests — please slow down and try again in a bit.');

    const actor = await getActor(getRequest());

    const methods = {
      email: data.methods?.email ?? true,
      push: data.methods?.push ?? false,
    };

    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT OR IGNORE INTO score_notify_subscriptions
              (id, target_kind, target_slug, target_label, email, user_id,
               methods_json, unsubscribe_token, notified_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        data.targetKind,
        data.targetSlug,
        data.targetLabel?.trim() || null,
        email,
        actor?.userId ?? null,
        JSON.stringify(methods),
        crypto.randomUUID(),
        null,
        new Date().toISOString(),
      ],
    });
    // Domain analytics (best-effort): which targets drive score-notify signups.
    void recordServerEvent(
      'score_subscribe',
      { kind: data.targetKind, push: methods.push, email: methods.email },
      getRequest()
    );
    // Return the STORED token (INSERT OR IGNORE keeps the original row on
    // re-subscribe, so the freshly generated one above may not be it). The
    // client keeps it locally to show the subscribed state and offer an
    // in-dialog unsubscribe without a lookup endpoint (no email enumeration).
    const row = await db.execute({
      sql: `SELECT unsubscribe_token FROM score_notify_subscriptions
            WHERE target_kind = ? AND target_slug = ? AND email = ? LIMIT 1`,
      args: [data.targetKind, data.targetSlug, email],
    });
    return { ok: true, token: (row.rows[0]?.unsubscribe_token as string | undefined) ?? null };
  });

export const unsubscribeScores = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UnsubscribeInput, d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const db = await getContributionsDb();
    await db.execute({
      sql: 'DELETE FROM score_notify_subscriptions WHERE unsubscribe_token = ?',
      args: [data.token],
    });
    return { ok: true };
  });

/**
 * The VAPID public key for the client subscribe flow. `null` when push isn't
 * configured (no VAPID env) — the dialog uses that to keep the Push option off.
 */
export const getScoreVapidPublicKey = createServerFn({ method: 'GET' }).handler(async () => ({
  publicKey: vapidPublicKey(),
}));

/**
 * Store a device's Web Push subscription for score notifications. Anonymous-safe
 * (no auth required) — push is device-based; `email` ties it back to the email
 * subscription rows so the delivery script can fan out to the right devices.
 * Endpoint is unique, so re-subscribing the same device refreshes its keys.
 */
export const saveScorePushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(PushSubInput, d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const email = data.email?.trim().toLowerCase() || null;
    const actor = await getActor(getRequest());
    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT INTO score_push_subscriptions (id, email, user_id, endpoint, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
              p256dh = excluded.p256dh, auth = excluded.auth,
              email = COALESCE(excluded.email, score_push_subscriptions.email)`,
      args: [
        crypto.randomUUID(),
        email,
        actor?.userId ?? null,
        data.endpoint,
        data.keys.p256dh,
        data.keys.auth,
        new Date().toISOString(),
      ],
    });
    return { ok: true };
  });

export const deleteScorePushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ endpoint: v.string() }), d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const db = await getContributionsDb();
    await db.execute({
      sql: 'DELETE FROM score_push_subscriptions WHERE endpoint = ?',
      args: [data.endpoint],
    });
    return { ok: true };
  });
