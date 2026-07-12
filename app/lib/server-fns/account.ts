/**
 * Account (/account) server functions — the signed-in user's own profile data.
 * All fns are self-scoped via getActor (no capability checks needed: you can
 * only ever read/mutate your own row). Anonymous callers get `signedIn: false`
 * instead of a throw, mirroring listMyLeagues — /account renders a sign-in
 * card for them.
 *
 * Code-split note (see consent.ts): only `.handler()` bodies may touch
 * server-only modules so the client bundle stays clean.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';

export interface AccountIdentity {
  name: string;
  email: string;
  image: string | null;
  role: string;
  createdAt: string | null;
  timeZone: string | null;
  contactConsent: boolean;
}

export interface AccountOverview {
  signedIn: boolean;
  identity: AccountIdentity | null;
  counts: {
    leagues: number;
    ballots: number;
    contributions: number;
    scoreSubscriptions: number;
  };
}

const EMPTY_OVERVIEW: AccountOverview = {
  signedIn: false,
  identity: null,
  counts: { leagues: 0, ballots: 0, contributions: 0, scoreSubscriptions: 0 },
};

export const getMyAccountOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AccountOverview> => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) return EMPTY_OVERVIEW;
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();

    const userRes = await db.execute({
      sql: `SELECT name, email, image, role, createdAt, timeZone, contactConsent
              FROM "user" WHERE id = ? LIMIT 1`,
      args: [actor.userId],
    });
    const u = userRes.rows[0];
    if (!u) return EMPTY_OVERVIEW;
    const email = String(u.email ?? '');

    // Cheap indexed counts — the overview tiles. Score subscriptions match by
    // user_id OR the session's own email (older/anonymous subs carry email only;
    // scoping to the authenticated email leaks nothing — see USER_PROFILE_PLAN D5).
    const countsRes = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM fantasy_members WHERE user_id = ?1 AND status = 'active') AS leagues,
              (SELECT COUNT(*) FROM prediction_ballots WHERE user_id = ?1) AS ballots,
              (SELECT COUNT(*) FROM show_revisions WHERE author_id = ?1) AS contributions,
              (SELECT COUNT(*) FROM score_notify_subscriptions WHERE user_id = ?1 OR email = ?2) AS score_subs`,
      args: [actor.userId, email],
    });
    const c = countsRes.rows[0]!;

    return {
      signedIn: true,
      identity: {
        name: String(u.name ?? ''),
        email,
        image: u.image == null ? null : String(u.image),
        role: String(u.role ?? 'user'),
        createdAt: u.createdAt == null ? null : String(u.createdAt),
        timeZone: u.timeZone == null ? null : String(u.timeZone),
        contactConsent: Number(u.contactConsent ?? 0) === 1,
      },
      counts: {
        leagues: Number(c.leagues ?? 0),
        ballots: Number(c.ballots ?? 0),
        contributions: Number(c.contributions ?? 0),
        scoreSubscriptions: Number(c.score_subs ?? 0),
      },
    };
  }
);

export const updateAccountName = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(
      v.object({
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
      }),
      d
    )
  )
  .handler(async ({ data }) => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    await db.execute({
      sql: `UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?`,
      args: [data.name, new Date().toISOString(), actor.userId],
    });
    return { ok: true as const, name: data.name };
  });

export const setContactConsent = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ contactConsent: v.boolean() }), d))
  .handler(async ({ data }) => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    await db.execute({
      sql: `UPDATE "user" SET contactConsent = ? WHERE id = ?`,
      args: [data.contactConsent ? 1 : 0, actor.userId],
    });
    return { ok: true as const };
  });
