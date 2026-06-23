/**
 * Generic transactional email (Fantasy DCI plan §8.1, M0).
 *
 * Refactored out of auth.ts's inline `sendMagicLink` so both auth and fantasy
 * notifications share one Resend path with the same dev fallback: when
 * RESEND_API_KEY is unset, we log the message to the console (so local dev still
 * works) instead of throwing. The `from` identity falls back to MAGIC_LINK_FROM,
 * overridable per-product via FANTASY_EMAIL_FROM (plan §19.3 D6).
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  /** Optional tag for Resend analytics / our own logging (e.g. 'fantasy_invite'). */
  tag?: string;
  /** Override the default sender; defaults to FANTASY_EMAIL_FROM ?? MAGIC_LINK_FROM. */
  from?: string;
};

const DEFAULT_FROM = 'corps.place <login@drumcorps.app>';

// Best-effort delivery log (ADMIN_PAGE_PLAN §10.3): record every send so operators can
// see a user's communications on /admin/users/$id. Never let logging break a send —
// swallow its errors. `userId`/`sentBy` are null for system sends (correlated by address).
const logSend = async (
  toAddr: string,
  subject: string,
  tag: string | undefined,
  status: 'sent' | 'failed' | 'skipped'
): Promise<void> => {
  try {
    const { getContributionsDb } = await import('@/lib/contributions-db');
    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT INTO email_log (email_id, to_addr, subject, tag, status, sent_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), toAddr, subject, tag ?? null, status, new Date().toISOString()],
    });
  } catch {
    /* logging is best-effort */
  }
};

export const sendEmail = async ({
  to,
  subject,
  html,
  tag,
  from,
}: SendEmailInput): Promise<void> => {
  const key = process.env.RESEND_API_KEY;
  const sender =
    from ?? process.env.FANTASY_EMAIL_FROM ?? process.env.MAGIC_LINK_FROM ?? DEFAULT_FROM;

  if (!key) {
    console.warn(
      `[email] RESEND_API_KEY not set — email NOT sent${tag ? ` (${tag})` : ''}. ` +
        `Would have sent to ${to}: ${subject}`
    );
    await logSend(to, subject, tag, 'skipped');
    return;
  }

  const { Resend } = await import('resend');
  const { error } = await new Resend(key).emails.send({
    from: sender,
    to,
    subject,
    html,
    ...(tag ? { tags: [{ name: 'category', value: tag }] } : {}),
  });
  await logSend(to, subject, tag, error ? 'failed' : 'sent');
  if (error) throw new Error(`Resend send failed: ${JSON.stringify(error)}`);
};
