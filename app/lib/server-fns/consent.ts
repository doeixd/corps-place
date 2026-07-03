/**
 * Consent server functions (site-wide first-sign-in gate). `acceptTerms` records
 * the signed-in user's acceptance of the current Terms/Privacy version plus their
 * optional contact opt-in, straight on the better-auth `user` row.
 *
 * NOTE: keep this file code-split-friendly — only the `.handler()` bodies touch
 * server-only modules (getContributionsDb), so the createServerFn transform strips
 * them from the client bundle. Do NOT add a module-scope helper that closes over a
 * server import (that defeats tree-shaking; see memory fantasy-jobs-deploy-bundle-leak).
 */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getActor } from '@/lib/authz';
import { getContributionsDb } from '@/lib/contributions-db';
import { CURRENT_TERMS_VERSION } from '@/lib/consent';

export const acceptTerms = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ contactConsent: v.boolean() }), d))
  .handler(async ({ data }) => {
    const actor = await getActor(getRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const db = await getContributionsDb();
    await db.execute({
      sql: `UPDATE "user" SET termsAcceptedAt = ?, termsVersion = ?, contactConsent = ? WHERE id = ?`,
      args: [
        new Date().toISOString(),
        CURRENT_TERMS_VERSION,
        data.contactConsent ? 1 : 0,
        actor.userId,
      ],
    });
    return { ok: true as const };
  });

// Persist the user's IANA time zone (e.g. 'America/New_York'), used to format times
// in emails. Auto-detected + saved client-side; also editable in notification prefs.
export const setTimeZone = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(
      v.object({
        timeZone: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(64),
          v.regex(/^[A-Za-z0-9_+\-/]+$/, 'Invalid time zone')
        ),
      }),
      d
    )
  )
  .handler(async ({ data }) => {
    const actor = await getActor(getRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const db = await getContributionsDb();
    await db.execute({
      sql: `UPDATE "user" SET timeZone = ? WHERE id = ?`,
      args: [data.timeZone, actor.userId],
    });
    return { ok: true as const };
  });
