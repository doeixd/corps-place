/**
 * NotificationService (migration plan §3.3 / P4b) — scheduled-job + email digest
 * dispatch on the Effect path. Ports `jobs.ts`: (re)enqueue draft reminders, then
 * the cron `dispatch` that processes due `fantasy_scheduled_jobs` and flushes
 * queued `fantasy_notifications` as one digest per recipient. Idempotent (guarded
 * by `done_at` / `email_sent_at`). Resend is wrapped via `Effect.promise`.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { sendEmail } from '@/lib/email';
import type { LeagueConfig } from '@/lib/fantasy/config';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

const MIN = 60_000;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APP_URL = (process.env.BETTER_AUTH_URL ?? 'https://drumcorps.app').replace(/\/$/, '');

// Format an instant in a recipient's IANA zone, e.g. "Sat, Aug 9, 8:00 PM EDT".
// Falls back to UTC if the stored zone is missing or invalid.
const formatWhen = (iso: string, timeZone: string | null): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timeZone || 'UTC',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
};

// UTC timestamp in iCalendar basic format: 20250809T200000Z.
const icsStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// A draft-start calendar event: a downloadable .ics (Apple/Outlook) plus a Google
// Calendar "add event" URL. The event is a 1-hour block at the scheduled start.
const buildDraftCalendar = (leagueName: string, slug: string, startIso: string) => {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 60 * MIN);
  const dtStart = icsStamp(start);
  const dtEnd = icsStamp(end);
  const url = `${APP_URL}/fantasy/${slug}/draft`;
  const title = `Draft — ${leagueName}`;
  const details = `Your fantasy drum corps draft. Be in the draft room: ${url}`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//drumcorps.app//fantasy//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:draft-${slug}-${dtStart}@drumcorps.app`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${details}`,
    `URL:${url}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${title}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const gcal =
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent(title)}` +
    `&dates=${dtStart}/${dtEnd}` +
    `&details=${encodeURIComponent(details)}`;
  return { ics, gcal, url };
};

export type DispatchSummary = { jobs: number; digests: number };

const makeNotificationService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;

  // Active members of a league with a deliverable email, plus the league name and
  // its notify.email gate — the shared shape behind every league email below.
  const leagueEmailTargets = (leagueId: string) =>
    Effect.gen(function* () {
      const leagueRows = yield* sql<{ name: string; slug: string; config_json: string }>`
        SELECT name, slug, config_json FROM fantasy_leagues WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const league = leagueRows[0];
      if (!league) return null;
      const config = JSON.parse(league.config_json) as LeagueConfig;
      if (!config.notify?.email) return null;
      const members = yield* sql<{ email: string; timeZone: string | null }>`
        SELECT u.email, u.timeZone FROM fantasy_members m
        JOIN user u ON u.id = m.user_id
        WHERE m.league_id = ${leagueId} AND m.status = 'active' AND u.email IS NOT NULL
          AND m.notify_email = 1 AND u.contactConsent = 1
      `.pipe(Effect.orDie);
      return { name: league.name, slug: league.slug, recipients: members };
    });

  // Immediate "your draft is set for X" confirmation when a draft is scheduled or
  // rescheduled (email parity, §12.4). Best-effort — the caller swallows failures
  // so a Resend hiccup never fails the scheduling mutation.
  const sendDraftScheduledEmail = (leagueId: string, scheduledAtIso: string) =>
    Effect.gen(function* () {
      const target = yield* leagueEmailTargets(leagueId);
      if (!target || target.recipients.length === 0) return;
      const safeName = escapeHtml(target.name);
      const cal = buildDraftCalendar(target.name, target.slug, scheduledAtIso);
      const icsB64 = Buffer.from(cal.ics, 'utf8').toString('base64');
      yield* Effect.promise(() =>
        Promise.all(
          target.recipients.map((r) =>
            sendEmail({
              to: r.email,
              subject: `Draft scheduled — ${target.name}`,
              // Time shown in the recipient's saved zone; calendar links cover the rest.
              html:
                `<p>The draft for <strong>${safeName}</strong> is set for ` +
                `<strong>${formatWhen(scheduledAtIso, r.timeZone)}</strong>.</p>` +
                `<p><a href="${cal.gcal}">Add to Google Calendar</a> — or open the attached ` +
                `<code>draft.ics</code> for Apple Calendar / Outlook. ` +
                `<a href="${cal.url}">Open the draft room</a> when it starts.</p>`,
              tag: 'fantasy_draft_scheduled',
              attachments: [{ filename: 'draft.ics', content: icsB64 }],
            })
          )
        )
      );
    });

  const enqueueDraftReminders = Effect.fn('NotificationService.enqueueDraftReminders')(function* (
    leagueId: string,
    scheduledAtIso: string
  ) {
    const startMs = new Date(scheduledAtIso).getTime();
    const now = Date.now();
    const nowIso = new Date().toISOString();

    yield* sql`
      DELETE FROM fantasy_scheduled_jobs
      WHERE league_id = ${leagueId} AND kind LIKE 'draft_soon_%' AND done_at IS NULL
    `.pipe(Effect.orDie);

    const candidates = [
      { kind: 'draft_soon_60', dueMs: startMs - 60 * MIN },
      { kind: 'draft_soon_10', dueMs: startMs - 10 * MIN },
    ].filter((j) => j.dueMs > now);

    yield* Effect.forEach(
      candidates,
      (j) =>
        sql`
          INSERT INTO fantasy_scheduled_jobs (job_id, league_id, kind, due_at, created_at)
          VALUES (${randomUUID()}, ${leagueId}, ${j.kind}, ${new Date(j.dueMs).toISOString()}, ${nowIso})
        `,
      { discard: true }
    ).pipe(Effect.orDie);

    yield* sendDraftScheduledEmail(leagueId, scheduledAtIso).pipe(
      Effect.catchCause((cause) => Effect.logError('fantasy draft-scheduled email failed', cause))
    );
  });

  const handleJob = (job: { kind: string; league_id: string | null }) =>
    Effect.gen(function* () {
      if (!job.kind.startsWith('draft_soon_') || !job.league_id) return;
      const leagueId = job.league_id;
      const leagueRows = yield* sql<{ name: string; config_json: string }>`
        SELECT name, config_json FROM fantasy_leagues WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const league = leagueRows[0];
      const config = JSON.parse(league?.config_json ?? '{}') as LeagueConfig;
      if (!config.notify?.email) return;

      const members = yield* sql<{ email: string; name: string | null }>`
        SELECT u.email, u.name FROM fantasy_members m
        JOIN user u ON u.id = m.user_id
        WHERE m.league_id = ${leagueId} AND m.status = 'active' AND u.email IS NOT NULL
          AND m.notify_email = 1 AND u.contactConsent = 1
      `.pipe(Effect.orDie);

      const name = league?.name ?? 'your league';
      const mins = job.kind === 'draft_soon_10' ? 10 : 60;
      const safeName = escapeHtml(name);
      yield* Effect.promise(() =>
        Promise.all(
          members.map((m) =>
            sendEmail({
              to: m.email,
              subject: `Your ${name} draft starts in ${mins} minutes`,
              html: `<p>Heads up — the draft for <strong>${safeName}</strong> starts in about ${mins} minutes. Be in the draft room when the clock starts.</p>`,
              tag: 'fantasy_draft_reminder',
            })
          )
        )
      );
    });

  const flushNotificationEmails = Effect.gen(function* () {
    const rows = yield* sql<{
      notif_id: string;
      user_id: string;
      league_id: string | null;
      kind: string;
      email: string;
      league_name: string | null;
    }>`
      SELECT n.notif_id, n.user_id, n.league_id, n.kind, u.email, l.name AS league_name
      FROM fantasy_notifications n
      JOIN user u ON u.id = n.user_id
      LEFT JOIN fantasy_leagues l ON l.league_id = n.league_id
      WHERE n.email_sent_at IS NULL AND n.kind IN ('standings', 'season_complete')
        AND u.contactConsent = 1
      ORDER BY n.user_id
    `.pipe(Effect.orDie);
    if (rows.length === 0) return 0;

    const byUser = new Map<
      string,
      { email: string; ids: string[]; leagues: Set<string>; final: boolean }
    >();
    for (const r of rows) {
      const entry = byUser.get(r.user_id) ?? {
        email: r.email,
        ids: [],
        leagues: new Set<string>(),
        final: false,
      };
      entry.ids.push(r.notif_id);
      if (r.league_name) entry.leagues.add(r.league_name);
      if (r.kind === 'season_complete') entry.final = true;
      byUser.set(r.user_id, entry);
    }

    const now = new Date().toISOString();
    let sent = 0;
    for (const entry of byUser.values()) {
      const leagues = [...entry.leagues].join(', ') || 'your league';
      const safeLeagues = escapeHtml(leagues);
      yield* Effect.promise(() =>
        sendEmail({
          to: entry.email,
          subject: entry.final
            ? `Final standings are in — ${leagues}`
            : `Standings updated — ${leagues}`,
          html: `<p>${entry.final ? 'The season is complete and final standings are locked' : 'Standings just updated after the latest recap'} for <strong>${safeLeagues}</strong>. Open the app to see where your corps landed.</p>`,
          tag: 'fantasy_standings',
        })
      );
      yield* Effect.forEach(
        entry.ids,
        (id) => sql`UPDATE fantasy_notifications SET email_sent_at = ${now} WHERE notif_id = ${id}`,
        { discard: true }
      ).pipe(Effect.orDie);
      sent++;
    }
    return sent;
  });

  const dispatch = Effect.fn('NotificationService.dispatch')(function* () {
    yield* requireDurableStorage; // I-7: don't mark jobs done / write digests on ephemeral storage
    const now = new Date().toISOString();
    const due = yield* sql<{ job_id: string; kind: string; league_id: string | null }>`
      SELECT * FROM fantasy_scheduled_jobs WHERE done_at IS NULL AND due_at <= ${now}
      ORDER BY due_at LIMIT 200
    `.pipe(Effect.orDie);

    for (const job of due) {
      // Best-effort: a failed reminder still gets marked done to avoid a poison loop,
      // but log the cause so a Resend outage isn't silently swallowed.
      yield* handleJob(job).pipe(
        Effect.catchCause((cause) => Effect.logError('fantasy job dispatch failed', cause))
      );
      yield* sql`
        UPDATE fantasy_scheduled_jobs SET done_at = ${new Date().toISOString()} WHERE job_id = ${job.job_id}
      `.pipe(Effect.orDie);
    }

    const digests = yield* flushNotificationEmails;
    return { jobs: due.length, digests } as DispatchSummary;
  });

  return { enqueueDraftReminders, dispatch };
});

export class NotificationService extends Context.Service<
  NotificationService,
  Effect.Success<typeof makeNotificationService>
>()('NotificationService') {}

export const NotificationServiceLive = Layer.effect(
  NotificationService,
  makeNotificationService
).pipe(Layer.provide(ContributionsSqlLive));
