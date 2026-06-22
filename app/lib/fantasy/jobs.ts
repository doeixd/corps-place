/**
 * Scheduled-job + notification dispatch (Fantasy DCI plan §8.1, H.4). SERVER-ONLY.
 *
 * Draft reminders and standings/season-complete emails are deploy-resilient: due
 * work lives in `fantasy_scheduled_jobs` / `fantasy_notifications` and a cron hits
 * the dispatcher every few minutes. Everything here is idempotent (guarded by
 * `done_at` / `email_sent_at`).
 */
import type { Client, Row } from '@libsql/client';
import { getContributionsDb } from '@/lib/contributions-db';
import { sendEmail } from '@/lib/email';
import type { LeagueConfig } from './config';

const MIN = 60_000;

/** Escape user-controlled text (league names) before interpolating into email HTML. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** (Re)enqueue the 60-min and 10-min "draft starts soon" reminders for a league. */
export async function enqueueDraftReminders(
  leagueId: string,
  scheduledAtIso: string
): Promise<void> {
  const db = await getContributionsDb();
  const startMs = new Date(scheduledAtIso).getTime();
  const now = Date.now();
  const nowIso = new Date().toISOString();

  // Reschedule cleanly: drop any still-pending reminders for this league first.
  await db.execute({
    sql: "DELETE FROM fantasy_scheduled_jobs WHERE league_id = ? AND kind LIKE 'draft_soon_%' AND done_at IS NULL",
    args: [leagueId],
  });

  const candidates = [
    { kind: 'draft_soon_60', dueMs: startMs - 60 * MIN },
    { kind: 'draft_soon_10', dueMs: startMs - 10 * MIN },
  ].filter((j) => j.dueMs > now);

  if (candidates.length === 0) return;
  await db.batch(
    candidates.map((j) => ({
      sql: `INSERT INTO fantasy_scheduled_jobs (job_id, league_id, kind, due_at, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), leagueId, j.kind, new Date(j.dueMs).toISOString(), nowIso],
    })),
    'write'
  );
}

type Recipient = { email: string; name: string | null };

const leagueRecipients = async (
  db: Client,
  leagueId: string
): Promise<{ name: string; config: LeagueConfig; members: Recipient[] }> => {
  const league = (
    await db.execute({
      sql: 'SELECT name, config_json FROM fantasy_leagues WHERE league_id = ?',
      args: [leagueId],
    })
  ).rows[0];
  const members = (
    await db.execute({
      sql: `SELECT u.email, u.name FROM fantasy_members m
            JOIN user u ON u.id = m.user_id
            WHERE m.league_id = ? AND m.status = 'active' AND u.email IS NOT NULL`,
      args: [leagueId],
    })
  ).rows.map((r) => ({ email: r.email as string, name: (r.name as string | null) ?? null }));
  return {
    name: (league?.name as string) ?? 'your league',
    config: JSON.parse((league?.config_json as string) ?? '{}') as LeagueConfig,
    members,
  };
};

async function handleJob(db: Client, job: Row): Promise<void> {
  const kind = job.kind as string;
  if (!kind.startsWith('draft_soon_')) return;
  const leagueId = job.league_id as string | null;
  if (!leagueId) return;
  const { name, config, members } = await leagueRecipients(db, leagueId);
  if (!config.notify?.email) return;
  const mins = kind === 'draft_soon_10' ? 10 : 60;
  const safeName = escapeHtml(name);
  await Promise.all(
    members.map((m) =>
      sendEmail({
        to: m.email,
        subject: `Your ${name} draft starts in ${mins} minutes`,
        html: `<p>Heads up — the draft for <strong>${safeName}</strong> starts in about ${mins} minutes. Be in the draft room when the clock starts.</p>`,
        tag: 'fantasy_draft_reminder',
      })
    )
  );
}

/** Send queued standings / season-complete notifications as one digest per user. */
async function flushNotificationEmails(db: Client): Promise<number> {
  const rows = (
    await db.execute({
      sql: `SELECT n.notif_id, n.user_id, n.league_id, n.kind, u.email, l.name AS league_name
            FROM fantasy_notifications n
            JOIN user u ON u.id = n.user_id
            LEFT JOIN fantasy_leagues l ON l.league_id = n.league_id
            WHERE n.email_sent_at IS NULL AND n.kind IN ('standings', 'season_complete')
            ORDER BY n.user_id`,
    })
  ).rows;
  if (rows.length === 0) return 0;

  // Group unsent notifications by recipient → one digest email each.
  const byUser = new Map<
    string,
    { email: string; ids: string[]; leagues: Set<string>; final: boolean }
  >();
  for (const r of rows) {
    const userId = r.user_id as string;
    const entry = byUser.get(userId) ?? {
      email: r.email as string,
      ids: [],
      leagues: new Set<string>(),
      final: false,
    };
    entry.ids.push(r.notif_id as string);
    if (r.league_name) entry.leagues.add(r.league_name as string);
    if ((r.kind as string) === 'season_complete') entry.final = true;
    byUser.set(userId, entry);
  }

  const now = new Date().toISOString();
  let sent = 0;
  for (const entry of byUser.values()) {
    const leagues = [...entry.leagues].join(', ') || 'your league';
    const safeLeagues = escapeHtml(leagues);
    await sendEmail({
      to: entry.email,
      subject: entry.final
        ? `Final standings are in — ${leagues}`
        : `Standings updated — ${leagues}`,
      html: `<p>${entry.final ? 'The season is complete and final standings are locked' : 'Standings just updated after the latest recap'} for <strong>${safeLeagues}</strong>. Open the app to see where your corps landed.</p>`,
      tag: 'fantasy_standings',
    });
    await db.batch(
      entry.ids.map((id) => ({
        sql: 'UPDATE fantasy_notifications SET email_sent_at = ? WHERE notif_id = ?',
        args: [now, id],
      })),
      'write'
    );
    sent++;
  }
  return sent;
}

export type DispatchSummary = { jobs: number; digests: number };

/** Process all due scheduled jobs and flush queued notification emails (H.4). */
export async function dispatchDueJobs(): Promise<DispatchSummary> {
  const db = await getContributionsDb();
  const now = new Date().toISOString();
  const due = (
    await db.execute({
      sql: 'SELECT * FROM fantasy_scheduled_jobs WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 200',
      args: [now],
    })
  ).rows;

  for (const job of due) {
    try {
      await handleJob(db, job);
    } catch {
      // Best-effort: a failed reminder still gets marked done to avoid a poison loop.
    }
    await db.execute({
      sql: 'UPDATE fantasy_scheduled_jobs SET done_at = ? WHERE job_id = ?',
      args: [new Date().toISOString(), job.job_id],
    });
  }

  const digests = await flushNotificationEmails(db);
  return { jobs: due.length, digests };
}
