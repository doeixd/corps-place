// Email DCI score-notify subscribers when an event's scores post. Called by
// scripts/auto-ingest-scores.sh after a new event's scores are ingested+published.
//
// Subscribers live in contributions.db (score_notify_subscriptions), written by the
// web app's subscribeScores server-fn. Event metadata + the corps that competed
// come from dci-relational.db. Sends via the Resend REST API (RESEND_API_KEY) — no
// extra dep. Idempotent per (subscriber, event): the event slug is appended to the
// row's notified_json so re-runs don't re-send.
//
// Usage: vp exec tsx scripts/notifyScoreSubscribers.ts --event <event-slug> [--event ...] [--dry-run]
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const events = args.flatMap((a, i) => (a === "--event" && args[i + 1] ? [args[i + 1]] : []));
if (events.length === 0) {
  console.log("[notify] no --event given; nothing to do.");
  process.exit(0);
}

const CONTRIB = process.env.CONTRIB_DB_PATH ?? "/data/corps-place/contributions.db";
const RELATIONAL = process.env.RELATIONAL_DB_PATH ?? "dci-relational.db";
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAGIC_LINK_FROM ?? "DrumCorps.app <noreply@drumcorps.app>";
const SITE = "https://drumcorps.app";

const cdb = new Database(CONTRIB);
const rdb = new Database(RELATIONAL, { readonly: true });

const eventLabel = (slug: string): string => {
  const r = rdb.prepare("SELECT name FROM events WHERE slug=? LIMIT 1").get(slug) as
    | { name: string }
    | undefined;
  return r?.name ?? slug;
};
const eventSeason = (slug: string): string | null => {
  const r = rdb.prepare("SELECT season FROM events WHERE slug=? LIMIT 1").get(slug) as
    | { season: string }
    | undefined;
  return r?.season ?? null;
};
// corps slugs that competed in this event (to match corps-subscribers)
const corpsInEvent = (slug: string): string[] => {
  const rows = rdb
    .prepare(
      `SELECT DISTINCT c.slug FROM corps_scores cs JOIN corps c ON c.corps_key = cs.corps_key
       WHERE cs.competition_slug = ? AND c.slug IS NOT NULL AND c.slug != ''`
    )
    .all(slug) as { slug: string }[];
  return rows.map((r) => r.slug);
};

const sendEmail = async (to: string, subject: string, html: string): Promise<boolean> => {
  if (!KEY) {
    console.log(`[notify] RESEND_API_KEY unset — would email ${to}: ${subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.warn(`[notify] Resend ${res.status} for ${to}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[notify] send failed for ${to}:`, e);
    return false;
  }
};

const main = async () => {
  let sent = 0;
  for (const ev of events) {
    const label = eventLabel(ev);
    const season = eventSeason(ev);
    const corps = corpsInEvent(ev);
    // Match both corps subs (target_slug = corps slug) and "event"/show subs
    // (target_slug = "<corps>/<season>") for every corps that competed here.
    const targets = [...corps, ...(season ? corps.map((c) => `${c}/${season}`) : [])];
    if (targets.length === 0) {
      console.log(`[notify] ${ev}: no corps resolved; skipping.`);
      continue;
    }
    const ph = targets.map(() => "?").join(",");
    const subs = cdb
      .prepare(
        `SELECT id, email, target_kind, target_slug, unsubscribe_token, notified_json
         FROM score_notify_subscriptions WHERE target_slug IN (${ph})`
      )
      .all(...targets) as {
      id: string;
      email: string;
      target_kind: string;
      target_slug: string;
      unsubscribe_token: string;
      notified_json: string | null;
    }[];

    // one email per address even if subscribed via both the event and a corps in it
    const byEmail = new Map<string, (typeof subs)[number]>();
    for (const s of subs) {
      const already = (() => {
        try {
          return (JSON.parse(s.notified_json ?? "[]") as string[]).includes(ev);
        } catch {
          return false;
        }
      })();
      if (already) continue;
      if (!byEmail.has(s.email)) byEmail.set(s.email, s);
    }

    console.log(`[notify] ${ev} (“${label}”): ${byEmail.size} to notify (${corps.length} corps in event).`);
    for (const [email, s] of byEmail) {
      const url = `${SITE}/events/${ev}`;
      const unsub = `${SITE}/notify/unsubscribe?token=${s.unsubscribe_token}`;
      const subject = `Scores are in — ${label}`;
      const html =
        `<p>Scores for <strong>${label}</strong> have been posted.</p>` +
        `<p><a href="${url}">View the recap on DrumCorps.app →</a></p>` +
        `<p style="color:#888;font-size:12px">You're getting this because you asked to be notified about ` +
        `${s.target_kind === "corps" ? "a corps in this show" : "this show"}. ` +
        `<a href="${unsub}">Unsubscribe</a>.</p>`;
      const ok = dryRun ? true : await sendEmail(email, subject, html);
      if (ok && !dryRun) {
        // mark this event notified for EVERY row of this email (event + corps subs)
        const rows = subs.filter((x) => x.email === email);
        for (const r of rows) {
          let arr: string[] = [];
          try {
            arr = JSON.parse(r.notified_json ?? "[]");
          } catch {
            arr = [];
          }
          if (!arr.includes(ev)) arr.push(ev);
          cdb.prepare("UPDATE score_notify_subscriptions SET notified_json=? WHERE id=?").run(
            JSON.stringify(arr),
            r.id
          );
        }
        sent++;
      } else if (dryRun) {
        console.log(`  [dry-run] would email ${email} (${s.target_kind}:${s.target_slug})`);
      }
    }
  }
  console.log(`[notify] ${dryRun ? "DRY RUN — " : ""}sent ${sent} email(s).`);
  cdb.close();
  rdb.close();
};

main().catch((e) => {
  console.error("[notify] fatal:", e);
  process.exitCode = 1;
});
