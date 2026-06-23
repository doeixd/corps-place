/**
 * Support server-fns (ADMIN_PAGE_PLAN §10). Public /contact submission + the
 * customerSupport-gated inbox, reply (logged), and unified user-detail lookup.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { getActor, requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import { sendEmail } from '@/lib/email';

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
    const actor = await getActor(getWebRequest()); // may be null (signed out)
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
      html: `<p>From: ${data.email}</p><p>${data.body.replace(/</g, '&lt;')}</p>`,
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
    await requireCapability(getWebRequest(), 'customerSupport');
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
    const actor = await requireCapability(getWebRequest(), 'customerSupport');
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
    const actor = await requireCapability(getWebRequest(), 'customerSupport');
    const db = await getContributionsDb();
    const msg = (
      await db.execute({
        sql: 'SELECT email, user_id FROM contact_messages WHERE message_id = ?',
        args: [data.messageId],
      })
    ).rows[0] as { email?: string; user_id?: string } | undefined;
    if (!msg?.email) throw new Error('NOT_FOUND');
    await sendEmail({
      to: msg.email,
      subject: data.subject,
      html: `<p>${data.body.replace(/</g, '&lt;')}</p>`,
      tag: 'support_reply',
    });
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO email_log (email_id, to_addr, subject, tag, user_id, sent_at, sent_by)
            VALUES (?, ?, ?, 'support_reply', ?, ?, ?)`,
      args: [crypto.randomUUID(), msg.email, data.subject, msg.user_id ?? null, now, actor.userId],
    });
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
    await requireCapability(getWebRequest(), 'customerSupport');
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
