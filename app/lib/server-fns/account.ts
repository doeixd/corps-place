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

// ── Notifications (USER_PROFILE_PLAN D5) ─────────────────────────────────────
// Listing is scoped to the session's own user_id OR verified email — this leaks
// nothing (you only ever see rows for the email you're signed in as). While
// listing, adopt legacy email-only rows into user_id (one-time backfill per row).

export interface MyScoreSubscription {
  id: string;
  targetKind: string;
  targetSlug: string;
  targetLabel: string | null;
  email: boolean;
  push: boolean;
  createdAt: string;
}

export const listMyScoreSubscriptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ signedIn: boolean; subscriptions: MyScoreSubscription[] }> => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) return { signedIn: false, subscriptions: [] };
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const emailRow = await db.execute({
      sql: 'SELECT email FROM "user" WHERE id = ? LIMIT 1',
      args: [actor.userId],
    });
    const email = String(emailRow.rows[0]?.email ?? '');
    // Adopt email-only rows (subscribed while signed out) into this account.
    await db.execute({
      sql: `UPDATE score_notify_subscriptions SET user_id = ? WHERE user_id IS NULL AND email = ?`,
      args: [actor.userId, email],
    });
    const res = await db.execute({
      sql: `SELECT id, target_kind, target_slug, target_label, methods_json, created_at
              FROM score_notify_subscriptions
             WHERE user_id = ? OR email = ?
             ORDER BY created_at DESC`,
      args: [actor.userId, email],
    });
    return {
      signedIn: true,
      subscriptions: res.rows.map((r) => {
        let methods: { email?: boolean; push?: boolean } = {};
        try {
          methods = JSON.parse(String(r.methods_json ?? '{}'));
        } catch {
          /* default */
        }
        return {
          id: String(r.id),
          targetKind: String(r.target_kind),
          targetSlug: String(r.target_slug),
          targetLabel: r.target_label == null ? null : String(r.target_label),
          email: methods.email !== false,
          push: methods.push === true,
          createdAt: String(r.created_at),
        };
      }),
    };
  }
);

/** Ownership check shared by the subscription mutations: the row must belong to
 *  this user_id or this session's email. Returns the row id or null. */
const OWNS_SUB_SQL = `SELECT s.id FROM score_notify_subscriptions s
   WHERE s.id = ? AND (s.user_id = ? OR s.email = (SELECT email FROM "user" WHERE id = ?))
   LIMIT 1`;

export const updateMyScoreSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ id: v.string(), email: v.boolean(), push: v.boolean() }), d)
  )
  .handler(async ({ data }) => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const owns = await db.execute({ sql: OWNS_SUB_SQL, args: [data.id, actor.userId, actor.userId] });
    if (owns.rows.length === 0) throw new Error('NOT_FOUND');
    await db.execute({
      sql: 'UPDATE score_notify_subscriptions SET methods_json = ? WHERE id = ?',
      args: [JSON.stringify({ email: data.email, push: data.push }), data.id],
    });
    return { ok: true as const };
  });

export const removeMyScoreSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ id: v.string() }), d))
  .handler(async ({ data }) => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const owns = await db.execute({ sql: OWNS_SUB_SQL, args: [data.id, actor.userId, actor.userId] });
    if (owns.rows.length === 0) throw new Error('NOT_FOUND');
    await db.execute({
      sql: 'DELETE FROM score_notify_subscriptions WHERE id = ?',
      args: [data.id],
    });
    return { ok: true as const };
  });

// ── Contributions ────────────────────────────────────────────────────────────

export interface MyContribution {
  revisionId: string;
  corpsKey: string | null;
  season: string | null;
  targetKind: string;
  op: string;
  summary: string | null;
  createdAt: string;
}

export const listMyContributions = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ offset: v.optional(v.number()) }), d ?? {}))
  .handler(
    async ({
      data,
    }): Promise<{ signedIn: boolean; total: number; contributions: MyContribution[] }> => {
      const { getActor } = await import('@/lib/authz');
      const actor = await getActor(getWebRequest());
      if (!actor) return { signedIn: false, total: 0, contributions: [] };
      const { getContributionsDb } = await import('@/lib/contributions-db');
      const db = await getContributionsDb();
      const offset = Math.max(0, Math.floor(data.offset ?? 0));
      const totalRes = await db.execute({
        sql: 'SELECT COUNT(*) AS n FROM show_revisions WHERE author_id = ? AND hidden = 0',
        args: [actor.userId],
      });
      const res = await db.execute({
        sql: `SELECT r.revision_id, r.target_kind, r.op, r.summary, r.created_at,
                     p.corps_key, p.season
                FROM show_revisions r
                LEFT JOIN show_pages p ON p.page_id = r.page_id
               WHERE r.author_id = ? AND r.hidden = 0
               ORDER BY r.created_at DESC LIMIT 50 OFFSET ?`,
        args: [actor.userId, offset],
      });
      return {
        signedIn: true,
        total: Number(totalRes.rows[0]?.n ?? 0),
        contributions: res.rows.map((r) => ({
          revisionId: String(r.revision_id),
          corpsKey: r.corps_key == null ? null : String(r.corps_key),
          season: r.season == null ? null : String(r.season),
          targetKind: String(r.target_kind),
          op: String(r.op),
          summary: r.summary == null ? null : String(r.summary),
          createdAt: String(r.created_at),
        })),
      };
    }
  );

// ── Staff/judge profile claims ───────────────────────────────────────────────

export interface MyProfileClaim {
  claimId: string;
  entityType: 'staff' | 'judge';
  entityId: string;
  status: string;
  matchedName: string | null;
  claimedAt: string;
}

export const listMyProfileClaims = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ signedIn: boolean; claims: MyProfileClaim[] }> => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) return { signedIn: false, claims: [] };
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: `SELECT claim_id, entity_type, entity_id, status, matched_name, claimed_at
              FROM profile_claims WHERE user_id = ? ORDER BY claimed_at DESC`,
      args: [actor.userId],
    });
    return {
      signedIn: true,
      claims: res.rows.map((r) => ({
        claimId: String(r.claim_id),
        entityType: (String(r.entity_type) === 'judge' ? 'judge' : 'staff') as 'staff' | 'judge',
        entityId: String(r.entity_id),
        status: String(r.status),
        matchedName: r.matched_name == null ? null : String(r.matched_name),
        claimedAt: String(r.claimed_at),
      })),
    };
  }
);

// ── Account lifecycle (USER_PROFILE_PLAN D3) ─────────────────────────────────

export const exportMyData = createServerFn({ method: 'POST' }).handler(async () => {
  const { getActor } = await import('@/lib/authz');
  const actor = await getActor(getWebRequest());
  if (!actor) throw new Error('UNAUTHENTICATED');
  const { getContributionsDb } = await import('@/lib/contributions-db');
  const db = await getContributionsDb();
  const rowsOf = async (sql: string) =>
    (await db.execute({ sql, args: [actor.userId] })).rows as unknown as Record<
      string,
      unknown
    >[];
  const user = (
    await db.execute({
      sql: 'SELECT id, name, email, role, "createdAt", timeZone FROM "user" WHERE id = ?',
      args: [actor.userId],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  if (!user) throw new Error('NOT_FOUND');
  const email = String(user.email ?? '');
  const payload = {
    exportedAt: new Date().toISOString(),
    user,
    revisions: await rowsOf('SELECT * FROM show_revisions WHERE author_id = ?'),
    media: await rowsOf('SELECT * FROM show_media WHERE uploaded_by = ?'),
    leaguesOwned: await rowsOf('SELECT * FROM fantasy_leagues WHERE owner_user_id = ?'),
    memberships: await rowsOf('SELECT * FROM fantasy_members WHERE user_id = ?'),
    ballots: await rowsOf('SELECT * FROM prediction_ballots WHERE user_id = ?'),
    profileClaims: await rowsOf('SELECT * FROM profile_claims WHERE user_id = ?'),
    contactMessages: await rowsOf('SELECT * FROM contact_messages WHERE user_id = ?'),
    scoreSubscriptions: (
      await db.execute({
        sql: 'SELECT * FROM score_notify_subscriptions WHERE user_id = ? OR email = ?',
        args: [actor.userId, email],
      })
    ).rows,
  };
  return { json: JSON.stringify(payload, null, 2) };
});

export const deleteMyAccount = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ confirm: v.literal('delete') }), d))
  .handler(async () => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const row = await db.execute({
      sql: 'SELECT email, role FROM "user" WHERE id = ? LIMIT 1',
      args: [actor.userId],
    });
    const email = String(row.rows[0]?.email ?? '');
    // Admins can't self-delete (last-admin lockout guard; use the admin console).
    if (String(row.rows[0]?.role ?? 'user') === 'admin') throw new Error('FORBIDDEN_ADMIN');

    const now = new Date().toISOString();
    // Owned fantasy leagues: transfer to the longest-standing active member, so
    // the league survives its founder (USER_PROFILE_PLAN open question #1).
    const owned = await db.execute({
      sql: 'SELECT league_id FROM fantasy_leagues WHERE owner_user_id = ?',
      args: [actor.userId],
    });
    for (const l of owned.rows) {
      const leagueId = String(l.league_id);
      const heir = await db.execute({
        sql: `SELECT user_id FROM fantasy_members
               WHERE league_id = ? AND user_id != ? AND status = 'active'
               ORDER BY joined_at ASC LIMIT 1`,
        args: [leagueId, actor.userId],
      });
      const heirId = heir.rows[0]?.user_id;
      if (heirId) {
        await db.batch(
          [
            {
              sql: 'UPDATE fantasy_leagues SET owner_user_id = ? WHERE league_id = ?',
              args: [String(heirId), leagueId],
            },
            {
              sql: `UPDATE fantasy_members SET role = 'owner' WHERE league_id = ? AND user_id = ?`,
              args: [leagueId, String(heirId)],
            },
          ],
          'write'
        );
      } else {
        // Sole member — the league dies with the account.
        await db.execute({
          sql: `UPDATE fantasy_leagues SET status = 'cancelled' WHERE league_id = ?`,
          args: [leagueId],
        });
      }
    }

    // Anonymize + detach everything personal. Wiki revisions stay (append-only
    // history, attributed to the anonymized row → renders as "Deleted user").
    // Profile claims are personal attestations → revoked; approved public
    // content (field overrides/photos) stays, same policy as wiki edits.
    await db.batch(
      [
        {
          sql: `UPDATE "user" SET name = 'Deleted user', email = ?, image = NULL,
                  banned = 1, banReason = 'account deleted by user' WHERE id = ?`,
          args: [`deleted+${actor.userId}@deleted.invalid`, actor.userId],
        },
        { sql: 'DELETE FROM session WHERE userId = ?', args: [actor.userId] },
        { sql: 'DELETE FROM account WHERE userId = ?', args: [actor.userId] },
        { sql: 'DELETE FROM passkey WHERE userId = ?', args: [actor.userId] },
        {
          sql: `DELETE FROM score_notify_subscriptions WHERE user_id = ? OR email = ?`,
          args: [actor.userId, email],
        },
        {
          sql: `DELETE FROM score_push_subscriptions WHERE user_id = ? OR email = ?`,
          args: [actor.userId, email],
        },
        { sql: 'DELETE FROM fantasy_push_subscriptions WHERE user_id = ?', args: [actor.userId] },
        { sql: 'DELETE FROM user_preferences WHERE user_id = ?', args: [actor.userId] },
        {
          sql: `UPDATE fantasy_members SET status = 'left' WHERE user_id = ?`,
          args: [actor.userId],
        },
        {
          sql: `UPDATE profile_claims SET status = 'revoked' WHERE user_id = ? AND status != 'revoked'`,
          args: [actor.userId],
        },
        { sql: 'UPDATE contact_messages SET email = NULL WHERE user_id = ?', args: [actor.userId] },
      ],
      'write'
    );
    return { ok: true as const };
  });

// ── Roaming preferences (USER_PROFILE_PLAN Phase 3 / D4) ─────────────────────
// One JSON blob per user. The client (account-sync) merges server↔local on
// sign-in and pushes debounced updates; the server just stores it. Size-bounded
// so a hostile client can't grow the row unboundedly.

const PREFS_MAX_BYTES = 256 * 1024;

export const getMyPreferences = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ signedIn: boolean; prefsJson: string | null; updatedAt: string | null }> => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) return { signedIn: false, prefsJson: null, updatedAt: null };
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: 'SELECT prefs_json, updated_at FROM user_preferences WHERE user_id = ? LIMIT 1',
      args: [actor.userId],
    });
    const row = res.rows[0];
    return {
      signedIn: true,
      prefsJson: row?.prefs_json == null ? null : String(row.prefs_json),
      updatedAt: row?.updated_at == null ? null : String(row.updated_at),
    };
  }
);

export const saveMyPreferences = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ prefsJson: v.pipe(v.string(), v.maxLength(PREFS_MAX_BYTES)) }), d)
  )
  .handler(async ({ data }) => {
    const { getActor } = await import('@/lib/authz');
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    // Must be valid JSON (defends the read path; content is client-owned).
    try {
      JSON.parse(data.prefsJson);
    } catch {
      throw new Error('INVALID_JSON');
    }
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT INTO user_preferences (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json,
                                               updated_at = excluded.updated_at`,
      args: [actor.userId, data.prefsJson, new Date().toISOString()],
    });
    return { ok: true as const };
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
