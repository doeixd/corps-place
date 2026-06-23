/**
 * User management (ADMIN_PAGE_PLAN §7). Direct on the better-auth `user` table in
 * `contributions.db` — the `role` additionalField column already exists, so role
 * grants need no plugin. Ban/impersonate require enabling the better-auth admin
 * plugin (a schema migration + auth-flow test) and are deferred to that session.
 *
 * Cap `manageUsers` (admin) on every fn; guard rails (no escalation above self, no
 * demoting the last admin) + an audit row on each change.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability, type Role } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';

const RANK: Record<Role, number> = { user: 1, trusted: 2, moderator: 3, admin: 4 };

/** H3: you may only ban/erase/modify users ranked BELOW you — never a peer or higher
 *  (prevents two admins from banning/erasing each other). Self-action is blocked
 *  separately by each fn. */
const assertCanActOn = (actorRole: Role, targetRole: Role): void => {
  if (RANK[targetRole] >= RANK[actorRole]) {
    throw new Error('FORBIDDEN: cannot act on a user at or above your role');
  }
};

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  banned: boolean;
  createdAt: string | null;
}

const ListUsersInput = v.object({
  q: v.optional(v.string(), ''),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)), 100),
});

/** List/search users by name or email. Cap: manageUsers. */
export const listUsers = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListUsersInput, d))
  .handler(async ({ data }): Promise<AdminUserRow[]> => {
    await requireCapability(getWebRequest(), 'manageUsers');
    const db = await getContributionsDb();
    const q = data.q.trim();
    const like = `%${q}%`;
    const rows = (
      await db.execute({
        sql: `SELECT id, name, email, role, banned, "createdAt"
              FROM "user"
              ${q ? 'WHERE name LIKE ? OR email LIKE ?' : ''}
              ORDER BY "createdAt" DESC LIMIT ?`,
        args: q ? [like, like, data.limit] : [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: (r.name as string) ?? null,
      email: (r.email as string) ?? null,
      role: ((r.role as Role) ?? 'user') as Role,
      banned: Boolean(r.banned),
      createdAt: (r.createdAt as string) ?? null,
    }));
  });

const BanInput = v.object({
  userId: v.string(),
  banned: v.boolean(),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
});

/** Ban/unban a user. Effective via getActor's banned-check + the plugin's
 *  session.create hook (blocks new sign-ins). Cap: manageUsers. */
export const setUserBanned = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(BanInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageUsers');
    if (data.userId === actor.userId) throw new Error('FORBIDDEN: cannot ban yourself');
    const db = await getContributionsDb();
    const target = (
      await db.execute({ sql: 'SELECT role FROM "user" WHERE id = ?', args: [data.userId] })
    ).rows[0] as { role?: string } | undefined;
    if (!target) throw new Error('NOT_FOUND');
    assertCanActOn(actor.role, (target.role as Role) ?? 'user'); // H3
    await db.execute({
      sql: 'UPDATE "user" SET banned = ?, banReason = ?, banExpires = NULL WHERE id = ?',
      args: [data.banned ? 1 : 0, data.banned ? (data.reason ?? '') : null, data.userId],
    });
    // M4: revoke existing sessions on ban (direct column write bypasses the plugin's
    // session deletion, so do it here). getActor also re-checks `banned` as backstop.
    if (data.banned) {
      await db.execute({ sql: 'DELETE FROM session WHERE "userId" = ?', args: [data.userId] });
    }
    await writeAudit(db, actor, {
      action: data.banned ? 'ban_user' : 'unban_user',
      target: data.userId,
      after: data.banned ? { reason: data.reason ?? '' } : null,
    });
    return { ok: true as const, userId: data.userId, banned: data.banned };
  });

// ---------------------------------------------------------------------------
// GDPR (ADMIN_PAGE_PLAN §7.1)
// ---------------------------------------------------------------------------
const UserIdInput = v.object({ userId: v.string() });

/** Enforce the `impersonate` capability + audit BEFORE the client calls the better-auth
 *  admin impersonate endpoint (H2 — the plugin only checks adminRoles; this adds our
 *  distinct cap gate + the audit trail). Cap: impersonate. */
export const logImpersonation = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UserIdInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'impersonate');
    if (data.userId === actor.userId) throw new Error('FORBIDDEN: cannot impersonate yourself');
    const db = await getContributionsDb();
    await writeAudit(db, actor, { action: 'impersonate_user', target: data.userId });
    return { ok: true as const };
  });

/** Export a user's data as a JSON-serializable object (right to access). Cap: manageUsers. */
export const exportUserData = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UserIdInput, d))
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'manageUsers');
    const db = await getContributionsDb();
    const rowsOf = async (sql: string) =>
      (await db.execute({ sql, args: [data.userId] })).rows as unknown as Record<string, unknown>[];
    const user = (
      await db.execute({
        sql: 'SELECT id, name, email, role, "createdAt" FROM "user" WHERE id = ?',
        args: [data.userId],
      })
    ).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!user) throw new Error('NOT_FOUND');
    const payload = {
      exportedAt: new Date().toISOString(),
      user,
      revisions: await rowsOf('SELECT * FROM show_revisions WHERE author_id = ?'),
      media: await rowsOf('SELECT * FROM show_media WHERE uploaded_by = ?'),
      leaguesOwned: await rowsOf('SELECT * FROM fantasy_leagues WHERE owner_user_id = ?'),
      memberships: await rowsOf('SELECT * FROM fantasy_members WHERE user_id = ?'),
      contactMessages: await rowsOf('SELECT * FROM contact_messages WHERE user_id = ?'),
    };
    // Serialize server-side so the GET return is a plain string (avoids the
    // not-provably-JSON Record<string, unknown> return-type constraint).
    return { json: JSON.stringify(payload, null, 2) };
  });

/** Right to erasure: anonymize the user (remove PII) while keeping content ids intact
 *  for scoring/wiki integrity. Bans to prevent re-login. Cap: manageUsers. */
export const anonymizeUser = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UserIdInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageUsers');
    if (data.userId === actor.userId) throw new Error('FORBIDDEN: cannot erase yourself');
    const db = await getContributionsDb();
    const target = (
      await db.execute({ sql: 'SELECT role FROM "user" WHERE id = ?', args: [data.userId] })
    ).rows[0] as { role?: string } | undefined;
    if (!target) throw new Error('NOT_FOUND');
    assertCanActOn(actor.role, (target.role as Role) ?? 'user'); // H3 (also blocks erasing admins)
    // Anonymize the PII-bearing rows; keep author_id/uploaded_by so content survives.
    await db.batch(
      [
        {
          sql: `UPDATE "user" SET name = 'Deleted user', email = ?, image = NULL,
                  banned = 1, banReason = 'account erased' WHERE id = ?`,
          args: [`deleted+${data.userId}@deleted.invalid`, data.userId],
        },
        { sql: 'UPDATE contact_messages SET email = NULL WHERE user_id = ?', args: [data.userId] },
      ],
      'write'
    );
    await writeAudit(db, actor, { action: 'gdpr_anonymize_user', target: data.userId });
    return { ok: true as const };
  });

const SetRoleInput = v.object({
  userId: v.string(),
  role: v.picklist(['user', 'trusted', 'moderator', 'admin'] as const),
});

/** Grant/revoke a user's role with guard rails. Cap: manageUsers. */
export const setUserRole = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetRoleInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageUsers');

    // Can't grant a role higher than your own.
    if (RANK[data.role as Role] > RANK[actor.role])
      throw new Error('FORBIDDEN: cannot escalate above your own role');

    const db = await getContributionsDb();
    const target = (
      await db.execute({ sql: 'SELECT role FROM "user" WHERE id = ?', args: [data.userId] })
    ).rows[0] as { role?: string } | undefined;
    if (!target) throw new Error('NOT_FOUND');
    const before = (target.role as Role) ?? 'user';
    if (before === data.role) return { ok: true as const, userId: data.userId, role: data.role };
    // H3: can't change the role of a peer/higher (incl. yourself, another admin) — this
    // also means admins can't be demoted here, so the last admin is always protected.
    assertCanActOn(actor.role, before);

    await db.execute({
      sql: 'UPDATE "user" SET role = ? WHERE id = ?',
      args: [data.role, data.userId],
    });
    await writeAudit(db, actor, {
      action: 'set_user_role',
      target: data.userId,
      before,
      after: data.role,
    });
    return { ok: true as const, userId: data.userId, role: data.role };
  });
