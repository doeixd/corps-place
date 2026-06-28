import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';

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

export const subscribeScores = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SubscribeInput, d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const email = data.email.trim().toLowerCase();

    // Anti-abuse throttle keyed by email (covers signed-out subscribers too).
    if (!rateLimit(`score-notify:subscribe:${email}`, 20, 60_000))
      throw new Error('Too many requests — please slow down and try again in a bit.');

    const actor = await getActor(getWebRequest());

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
    return { ok: true };
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
