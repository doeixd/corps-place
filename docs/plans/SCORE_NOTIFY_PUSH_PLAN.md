# Score-notify Web Push (PWA) — plan

Status: **DRAFT for review** — not started. Builds on the shipped email-only "notify me of scores" feature.

## 0. TL;DR / Goal

Let people get **native push notifications** (not just email) when scores post for an event or corps they follow — using standard **PWA web push** (Service Worker + Push API + VAPID), no third party. The dialog's Push toggle (currently disabled "Coming soon") becomes active.

**The build is small because the stack already exists** (built for fantasy, currently dormant). The single thing gating it is **VAPID keys aren't configured**, so push is a no-op everywhere — including fantasy.

## 1. Grounding — what already exists (verified 2026-06-28)

- **Service worker** `public/sw.js` — already has generic `push` + `notificationclick` handlers; payload is `{ title, body, url? }`. **No SW change needed.** Registered via `app/lib/register-sw.ts`.
- **Sender** `app/lib/fantasy/push.ts` — `sendPushToUser(userId, {title, body, url})` using the `web-push` dep (`^3.6.7`), `webpush.setVapidDetails(...)`, prunes dead subs on 404/410. `pushConfigured()` + `vapidPublicKey()` expose config to the client.
- **Client subscribe flow** `app/components/fantasy/push-toggle.tsx` — `Notification.requestPermission()` → `serviceWorker.ready` → `pushManager.subscribe({ applicationServerKey: urlBase64ToUint8Array(publicKey) })` → store via a server-fn. Reusable pattern (incl. the `urlBase64ToUint8Array` helper).
- **Storage** `fantasy_push_subscriptions (user_id, endpoint, p256dh, auth)` — fantasy's per-user device table. `score_notify_subscriptions` (email-keyed, anyone) already exists for email.
- **Env vars** the code reads: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. **NOT set in `.env` (0 keys)** → `pushConfigured()` is false → all push is currently a no-op.

**Net:** the only truly new work is (a) VAPID keys, (b) device-subscription storage for the **anonymous** (not-signed-in) score-notify audience, (c) wiring the dialog toggle + the VM delivery script. Enabling this **also lights up fantasy push** for free.

## 2. Design decisions

1. **Anonymous, device-based.** Score-notify is "anyone by email"; push is inherently **per-device** (the subscription *is* the device). So store the push subscription **alongside the score_notify_subscriptions row** (or a small linked table) — no sign-in required. `user_id` stays optional.
2. **Reuse, don't fork.** Same SW, same `web-push`, same VAPID, same subscribe flow as fantasy. Generalize `fantasy/push.ts` into a shared `lib/push.ts` (`sendPush(subscription, payload)`) that both fantasy and score-notify call; keep `sendPushToUser` as a thin wrapper.
3. **Methods are independent.** A row's `methods_json` already has `{email, push}`. Honor both: a subscriber who picked email **and** push gets both; one email per address + one push per device (de-duped per channel, §5).
4. **VAPID keys are infra, set once.** Generate one keypair; the public key is safe to ship to the client (via a server-fn `getVapidPublicKey()` or the loader), the private key stays server-only in env.

## 3. Schema

Add device columns to `score_notify_subscriptions` (nullable; populated only when push is chosen) OR a linked table. Prefer a **linked table** so one email can have many devices and to mirror fantasy:

```
CREATE TABLE IF NOT EXISTS score_push_subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT,                 -- ties to score_notify_subscriptions.email (nullable; device-only ok)
  user_id TEXT,              -- optional
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_score_push_endpoint ON score_push_subscriptions (endpoint);
```
On notify, a `push`-method `score_notify_subscriptions` row → look up `score_push_subscriptions` by that email → send to each endpoint. (Add to `contributions-db.ts` SCHEMA, which self-applies on first DB access — verified pattern.)

## 4. Pieces to build

- **VAPID keys (gating):** `npx web-push generate-vapid-keys` → set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT=mailto:login@drumcorps.app` in the box `.env` **and the prod container env** (Coolify — encrypted; the gated step that needs the owner / the Coolify API). Until prod env is set, push stays a no-op in prod even with the code wired.
- **Server-fn** (`score-notify.ts` or a new `push.ts`): `getVapidPublicKey()`; extend `subscribeScores` (or add `subscribeScorePush`) to accept a `PushSubscriptionJSON` and upsert into `score_push_subscriptions`; an unsubscribe-device path.
- **Client** (`score-notify-button.tsx`): when Push is toggled on, run the fantasy subscribe flow (request permission, subscribe with the VAPID public key, POST the subscription). Reflect denied/granted state; show "enable in browser settings" if denied. Flip the toggle from disabled "Coming soon" → active **gated on `pushConfigured()`** (hide/disable if VAPID unset, so it never half-works).
- **Delivery** (`sdk/scripts/notifyScoreSubscribers.ts`): after the email path, for each notified subscriber whose `methods_json.push` is true, look up their `score_push_subscriptions` and send a web-push `{title:"Scores are in — <event>", body, url}`. **Add `web-push` to the sdk deps** (`vp add web-push`); mirror `fantasy/push.ts` (setVapidDetails, prune 404/410). Mark notified the same way as email (`notified_json`) so re-runs don't re-push.

## 5. De-dup & correctness

- **Per channel:** one email per address (already), one push per endpoint. A person with email+push gets one of each — intended.
- **Idempotent:** reuse `notified_json` (event slug) so a re-run of the delivery doesn't re-push/re-email.
- **Dead subs:** prune `score_push_subscriptions` on `web-push` 404/410 (mirror fantasy).
- **Correct corps/event:** reuse the canonical event/corps resolution already in the delivery script.

## 6. iOS / platform caveats (call out in the UI)

- **iOS Safari:** web push only works for a site **installed to the home screen** (PWA) on iOS 16.4+. In-browser iOS gets nothing. The dialog should say "On iPhone, add DrumCorps.app to your Home Screen first."
- Android Chrome / desktop Chrome/Edge/Firefox: works in-browser.
- Permission is per-origin and can be denied/blocked — handle the denied path gracefully.

## 7. Phases

- **P0 — Enable the platform:** generate VAPID keys, set box `.env` + prod env. (Lights up fantasy push too; verify with the existing fantasy toggle.)
- **P1 — Storage + server:** `score_push_subscriptions` table, `getVapidPublicKey`, `subscribeScorePush`.
- **P2 — Client:** wire the dialog Push toggle (reuse fantasy flow), gate on `pushConfigured()`, iOS copy.
- **P3 — Delivery:** web-push path in `notifyScoreSubscribers.ts` (+ `web-push` in sdk), prune dead subs.
- **P4 — Polish/refactor:** extract shared `lib/push.ts`; test end-to-end (subscribe on a device → ingest a show → receive the push).

## 8. Risks / notes

- **Prod env is the gate** — wiring is inert until `VAPID_*` is in the prod container env. Surface `pushConfigured()` so the toggle never shows active when keys are missing.
- **Key rotation** — changing VAPID keys invalidates all existing subscriptions; generate once and keep.
- **VM has web-push?** the delivery runs under sdk (Node 20) — add `web-push` there; it's pure JS (no native dep), so no ABI risk.
- **Non-goal:** rich notification actions / images for v1; topic-style broadcast — we fan out per stored subscription.
```
