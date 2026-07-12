// Record one auto-ingest cron run into contributions.db (ingest_runs) so /admin
// can show cron health + logs instead of log-spelunking on the box, and — on a
// failure — push every registered admin device (admin_push_subscriptions).
//
// Called by scripts/auto-ingest-scores.sh's write_report (best-effort; must never
// fail the ingest run). Mirrors notifyScoreSubscribers.ts: local contributions.db
// via better-sqlite3, web-push via VAPID env. Both tables are created lazily by the
// app too — CREATE IF NOT EXISTS keeps whoever runs first authoritative.
//
// Usage:
//   vp exec tsx scripts/recordIngestRun.ts --status scrape_failed --season 2026 \
//     --before 9339 --after 9339 --pending "2026-foo 2026-bar" --published false \
//     --detail "scrape FAILED" [--alert]
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import webpush from "web-push";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);
const numOrNull = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const status = flag("status") ?? "unknown";
const kind = flag("kind") ?? "score-ingest";
const season = flag("season") ?? null;
const pending = flag("pending") ?? null;
const before = numOrNull(flag("before"));
const after = numOrNull(flag("after"));
const delta = before != null && after != null ? after - before : null;
const published = (flag("published") ?? "false") === "true" ? 1 : 0;
const detail = flag("detail") ?? null;
// Alert on an explicit --alert OR whenever the run failed.
const alert = has("alert") || status === "scrape_failed";

const CONTRIB = process.env.CONTRIB_DB_PATH ?? "/data/corps-place/contributions.db";
const db = new Database(CONTRIB);
db.pragma("busy_timeout = 5000");

// Mirror app/lib/contributions-db.ts (both use IF NOT EXISTS).
db.exec(
  `CREATE TABLE IF NOT EXISTS ingest_runs (
     run_id TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
     season TEXT, pending_events TEXT, scores_before INTEGER, scores_after INTEGER,
     scores_delta INTEGER, published INTEGER NOT NULL DEFAULT 0, detail TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_ingest_runs_ts ON ingest_runs (ts DESC);
   CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
     endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL,
     auth TEXT NOT NULL, created_at TEXT NOT NULL
   );`
);

const ts = new Date().toISOString();
db.prepare(
  `INSERT INTO ingest_runs
     (run_id, ts, kind, status, season, pending_events, scores_before, scores_after, scores_delta, published, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(
  randomUUID(),
  ts,
  kind,
  status,
  season,
  pending,
  before,
  after,
  delta,
  published,
  detail
);
console.log(`[record-run] ingest_runs += ${status} (delta=${delta ?? "?"})`);

// Prune ancient rows so the table stays small (keep the most recent 500).
db.exec(
  `DELETE FROM ingest_runs WHERE run_id NOT IN
     (SELECT run_id FROM ingest_runs ORDER BY ts DESC LIMIT 500)`
);

async function alertAdmins(): Promise<void> {
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:login@drumcorps.app";
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log("[record-run] VAPID keys unset — falling back to email.");
    await emailAdminsFallback();
    return;
  }
  const subs = db
    .prepare("SELECT endpoint, p256dh, auth FROM admin_push_subscriptions")
    .all() as { endpoint: string; p256dh: string; auth: string }[];
  if (subs.length === 0) {
    console.log("[record-run] no admin push subscriptions registered — falling back to email.");
    await emailAdminsFallback();
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  // A hard scrape failure ingested nothing; anything else with a detail is a
  // partial failure (e.g. scores published but a full-emit/fantasy step failed).
  const hardFail = status === "scrape_failed";
  const label = kind === "lineup-refresh" ? "Lineup refresh" : "Score auto-ingest";
  const title = hardFail ? `⚠️ ${label} FAILED` : `⚠️ ${label} issue (${status})`;
  const body =
    (pending ? `Pending: ${pending}. ` : "") +
    (detail || (hardFail ? "Scrape failed." : "See admin jobs."));
  const payload = JSON.stringify({
    title,
    body,
    url: "https://drumcorps.app/admin/jobs",
  });
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      delivered++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        db.prepare("DELETE FROM admin_push_subscriptions WHERE endpoint = ?").run(s.endpoint);
      }
    }
  }
  console.log(`[record-run] admin alert: ${delivered}/${subs.length} devices notified.`);
  if (delivered === 0) await emailAdminsFallback();
}

// Email fallback so failures still reach a human when web push can't (no
// subscriptions registered / VAPID unset / all pushes bounced — the 2026-07-12
// Grand Prix outage failed 18 runs in a row into a dead alert channel).
// Throttled: at most one alert email per hour, keyed off prior failure rows in
// ingest_runs, so a repeating failure doesn't flood the inbox.
const ALERT_EMAIL = process.env.INGEST_ALERT_EMAIL ?? "ithepatrickglenni@gmail.com";
async function emailAdminsFallback(): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("[record-run] RESEND_API_KEY unset — email fallback skipped.");
    return;
  }
  // Another failure row in the last hour (besides the one just inserted) means
  // an email either just went out or was already throttled — stay quiet.
  // NOTE: ts is stored as an ISO string ('...T...Z'); sqlite's datetime() emits
  // 'YYYY-MM-DD HH:MM:SS' (space separator), and comparing the two as strings
  // matched EVERYTHING ('T' > ' ') — the throttle read "157 failures in the
  // last hour" and permanently suppressed the fallback. Compare ISO-to-ISO.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ingest_runs
        WHERE status IN ('scrape_failed', 'publish_failed')
          AND ts >= ? AND ts < ?`
    )
    .get(cutoff, ts) as { n: number };
  if (recent.n > 0) {
    console.log(`[record-run] email fallback throttled (${recent.n} failure(s) in the last hour).`);
    return;
  }
  const from = process.env.MAGIC_LINK_FROM ?? "DrumCorps.app <login@drumcorps.app>";
  const subject = `⚠️ ${kind === "lineup-refresh" ? "Lineup refresh" : "Score auto-ingest"} ${status}`;
  const text =
    `Status: ${status}\n` +
    (pending ? `Pending show(s): ${pending}\n` : "") +
    (detail ? `Detail: ${detail}\n` : "") +
    `Scores before/after: ${before ?? "?"} / ${after ?? "?"}\n\n` +
    `Runs & logs: https://drumcorps.app/admin/jobs\n` +
    `(Sent because no web-push admin device is registered — enable admin ` +
    `notifications on the site to get pushes instead.)`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [ALERT_EMAIL], subject, text }),
    });
    console.log(
      res.ok
        ? `[record-run] alert emailed to ${ALERT_EMAIL}.`
        : `[record-run] alert email failed: HTTP ${res.status}`
    );
  } catch (err) {
    console.log(`[record-run] alert email failed: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  if (alert) await alertAdmins();
  db.close();
}

void main();
