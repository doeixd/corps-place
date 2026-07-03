/**
 * Support server-fns (ADMIN_PAGE_PLAN §10). Public /contact submission + the
 * customerSupport-gated inbox, reply (logged), and unified user-detail lookup.
 */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { getActor, requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import { sendEmail } from '@/lib/email';

// Escape all HTML-significant chars before interpolating user text into an email body
// (review M7 — the prior `<`-only replace left `&`/`"`/`>` unescaped).
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

// ---------------------------------------------------------------------------
// public: submit a contact message
// ---------------------------------------------------------------------------
const ContactInput = v.object({
  email: v.pipe(v.string(), v.trim(), v.email('A valid email is required'), v.maxLength(200)),
  subject: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(150)), ''),
  body: v.pipe(v.string(), v.trim(), v.minLength(1, 'Message required'), v.maxLength(5000)),
  topic: v.optional(v.pipe(v.string(), v.maxLength(50)), 'general'),
  // Honeypot: bots fill hidden fields; humans never do. Must be empty.
  website: v.optional(v.string(), ''),
});

export const submitContact = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(ContactInput, d))
  .handler(async ({ data }) => {
    if (data.website) return { ok: true as const }; // silently drop bot submissions
    const actor = await getActor(getRequest()); // may be null (signed out)
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO contact_messages (message_id, user_id, email, subject, body, topic, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      args: [
        crypto.randomUUID(),
        actor?.userId ?? null,
        data.email,
        data.subject ?? '',
        data.body,
        data.topic ?? 'general',
        now,
      ],
    });
    // Best-effort operator notification (no-op in dev without RESEND_API_KEY).
    await sendEmail({
      to: process.env.SUPPORT_INBOX ?? process.env.MAGIC_LINK_FROM ?? 'login@drumcorps.app',
      subject: `[contact] ${data.subject || data.topic || 'New message'}`,
      html: `<p>From: ${esc(data.email)}</p><p>${esc(data.body)}</p>`,
      tag: 'contact',
    }).catch(() => {});
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// admin: inbox
// ---------------------------------------------------------------------------
export interface ContactRow {
  messageId: string;
  userId: string | null;
  email: string | null;
  subject: string | null;
  body: string;
  topic: string | null;
  status: string;
  createdAt: string;
}

const ListContactInput = v.object({
  status: v.optional(v.picklist(['open', 'replied', 'closed', 'all']), 'open'),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 100),
});

export const listContactMessages = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListContactInput, d))
  .handler(async ({ data }): Promise<ContactRow[]> => {
    await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const where = data.status === 'all' ? '' : 'WHERE status = ?';
    const rows = (
      await db.execute({
        sql: `SELECT message_id, user_id, email, subject, body, topic, status, created_at
              FROM contact_messages ${where} ORDER BY created_at DESC LIMIT ?`,
        args: data.status === 'all' ? [data.limit] : [data.status, data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      messageId: String(r.message_id),
      userId: (r.user_id as string) ?? null,
      email: (r.email as string) ?? null,
      subject: (r.subject as string) ?? null,
      body: String(r.body),
      topic: (r.topic as string) ?? null,
      status: String(r.status),
      createdAt: String(r.created_at),
    }));
  });

export const setContactStatus = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(
      v.object({ messageId: v.string(), status: v.picklist(['open', 'replied', 'closed']) }),
      d
    )
  )
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: 'UPDATE contact_messages SET status = ?, handled_by = ?, handled_at = ? WHERE message_id = ?',
      args: [data.status, actor.userId, new Date().toISOString(), data.messageId],
    });
    if (res.rowsAffected === 0) throw new Error('NOT_FOUND');
    await writeAudit(db, actor, {
      action: 'contact_set_status',
      target: data.messageId,
      after: data.status,
    });
    return { ok: true as const };
  });

const ReplyInput = v.object({
  messageId: v.string(),
  subject: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
});

/** Reply to a contact message by email, log it, and mark replied. Cap: customerSupport. */
export const replyContact = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(ReplyInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const msg = (
      await db.execute({
        sql: 'SELECT email, user_id FROM contact_messages WHERE message_id = ?',
        args: [data.messageId],
      })
    ).rows[0] as { email?: string; user_id?: string } | undefined;
    if (!msg?.email) throw new Error('NOT_FOUND');
    // sendEmail logs the delivery to email_log itself (by address) — no manual insert.
    await sendEmail({
      to: msg.email,
      subject: data.subject,
      html: `<p>${esc(data.body)}</p>`,
      tag: 'support_reply',
    });
    const now = new Date().toISOString();
    await db.execute({
      sql: 'UPDATE contact_messages SET status = ?, handled_by = ?, handled_at = ? WHERE message_id = ?',
      args: ['replied', actor.userId, now, data.messageId],
    });
    await writeAudit(db, actor, { action: 'contact_reply', target: data.messageId });
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// admin: unified user detail (support home base)
// ---------------------------------------------------------------------------
export const getUserDetail = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ userId: v.string() }), d))
  .handler(async ({ data }) => {
    await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const u = (
      await db.execute({
        sql: 'SELECT id, name, email, role, banned, "createdAt" FROM "user" WHERE id = ?',
        args: [data.userId],
      })
    ).rows[0] as Record<string, unknown> | undefined;
    if (!u) throw new Error('NOT_FOUND');
    const count = async (sql: string) =>
      Number((await db.execute({ sql, args: [data.userId] })).rows[0]?.n ?? 0);
    const [revisions, uploads, leaguesOwned, leaguesJoined, contacts] = await Promise.all([
      count('SELECT COUNT(*) AS n FROM show_revisions WHERE author_id = ?'),
      count('SELECT COUNT(*) AS n FROM show_media WHERE uploaded_by = ?'),
      count('SELECT COUNT(*) AS n FROM fantasy_leagues WHERE owner_user_id = ?'),
      count('SELECT COUNT(*) AS n FROM fantasy_members WHERE user_id = ?'),
      count('SELECT COUNT(*) AS n FROM contact_messages WHERE user_id = ?'),
    ]);
    return {
      user: {
        id: String(u.id),
        name: (u.name as string) ?? null,
        email: (u.email as string) ?? null,
        role: (u.role as string) ?? 'user',
        banned: Boolean(u.banned),
        createdAt: (u.createdAt as string) ?? null,
      },
      activity: { revisions, uploads, leaguesOwned, leaguesJoined, contacts },
    };
  });

// ---------------------------------------------------------------------------
// admin: communications + sessions for a user (§10.2/§10.3)
// ---------------------------------------------------------------------------
const lookupEmail = async (
  db: Awaited<ReturnType<typeof getContributionsDb>>,
  userId: string
): Promise<string | null> => {
  const u = (await db.execute({ sql: 'SELECT email FROM "user" WHERE id = ?', args: [userId] }))
    .rows[0] as { email?: string } | undefined;
  return u?.email ?? null;
};

export interface EmailLogRow {
  emailId: string;
  subject: string | null;
  tag: string | null;
  status: string | null;
  sentAt: string;
}

/** Emails sent to a user (delivery log, correlated by address). Cap: customerSupport. */
export const listUserEmails = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ userId: v.string() }), d))
  .handler(async ({ data }): Promise<EmailLogRow[]> => {
    await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const email = await lookupEmail(db, data.userId);
    if (!email) return [];
    const rows = (
      await db.execute({
        sql: `SELECT email_id, subject, tag, status, sent_at
              FROM email_log WHERE to_addr = ? ORDER BY sent_at DESC LIMIT 100`,
        args: [email],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      emailId: String(r.email_id),
      subject: (r.subject as string) ?? null,
      tag: (r.tag as string) ?? null,
      status: (r.status as string) ?? null,
      sentAt: String(r.sent_at),
    }));
  });

export interface SessionRow {
  id: string;
  createdAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** A user's active better-auth sessions. Cap: customerSupport. */
export const listUserSessions = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ userId: v.string() }), d))
  .handler(async ({ data }): Promise<SessionRow[]> => {
    await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const rows = (
      await db.execute({
        sql: `SELECT id, "createdAt", "expiresAt", "ipAddress", "userAgent"
              FROM session WHERE "userId" = ? ORDER BY "createdAt" DESC`,
        args: [data.userId],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      createdAt: (r.createdAt as string) ?? null,
      expiresAt: (r.expiresAt as string) ?? null,
      ipAddress: (r.ipAddress as string) ?? null,
      userAgent: (r.userAgent as string) ?? null,
    }));
  });

/** Force-logout: revoke all of a user's sessions (account recovery / security).
 *  Cap: customerSupport. Audited. */
export const revokeUserSessions = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ userId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: 'DELETE FROM session WHERE "userId" = ?',
      args: [data.userId],
    });
    await writeAudit(db, actor, {
      action: 'revoke_sessions',
      target: data.userId,
      after: { revoked: res.rowsAffected },
    });
    return { ok: true as const, revoked: res.rowsAffected };
  });

/** Audit a support-initiated sign-in-link send (the magic link itself is sent by the
 *  better-auth client flow to the user's own inbox). Cap: customerSupport. */
export const logSignInLinkSent = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ userId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'customerSupport');
    await writeAudit(await getContributionsDb(), actor, {
      action: 'send_signin_link',
      target: data.userId,
    });
    return { ok: true as const };
  });
