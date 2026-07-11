import { createServerFileRoute } from '@tanstack/react-start/server';
import { getContributionsDb } from '@/lib/contributions-db';

/**
 * Inbound support-email webhook. Cloudflare Email Routing (an Email Worker on the
 * `support+*@` addresses) POSTs a parsed reply here so it threads back into the
 * /admin/support conversation instead of vanishing. Authenticated by a shared
 * secret (INBOUND_EMAIL_SECRET) — it creates DB rows, so it must not be open.
 *
 * Payload: `{ to, from, subject, text }`. The thread id rides in the `to`
 * plus-address (`support+<messageId>@…`); if that's missing/unknown we fall back
 * to matching the sender's address to their most recent contact message.
 */
export const ServerRoute = createServerFileRoute('/api/inbound-email').methods({
  POST: async ({ request }) => {
    const secret = process.env.INBOUND_EMAIL_SECRET;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    let payload: { to?: string; from?: string; subject?: string; text?: string };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return new Response('Bad payload', { status: 400 });
    }
    const from = (payload.from ?? '').trim().toLowerCase();
    const body = (payload.text ?? '').slice(0, 20_000).trim();
    if (!from || !body) return new Response('Missing from/text', { status: 400 });

    const db = await getContributionsDb();

    // Thread id from the plus-address: support+<messageId>@domain.
    let messageId = (payload.to ?? '').match(/\+([^@]+)@/)?.[1] ?? null;
    if (messageId) {
      const known =
        (
          await db.execute({
            sql: 'SELECT 1 FROM contact_messages WHERE message_id = ? LIMIT 1',
            args: [messageId],
          })
        ).rows.length > 0;
      if (!known) messageId = null;
    }
    if (!messageId) {
      const row = (
        await db.execute({
          sql: 'SELECT message_id FROM contact_messages WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1',
          args: [from],
        })
      ).rows[0] as { message_id?: string } | undefined;
      messageId = row?.message_id ?? null;
    }
    // Accept (2xx, so the sender isn't retried) even when we can't thread it.
    if (!messageId) return new Response('No matching thread', { status: 202 });

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO contact_replies (reply_id, message_id, direction, from_addr, subject, body, created_at)
            VALUES (?, ?, 'inbound', ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        messageId,
        from,
        (payload.subject ?? '').slice(0, 200),
        body,
        now,
      ],
    });
    // A reply pulls a handled message back into the open queue so it's seen.
    await db.execute({
      sql: `UPDATE contact_messages SET status = 'open' WHERE message_id = ? AND status = 'replied'`,
      args: [messageId],
    });
    return new Response('OK', { status: 200 });
  },
});
