# User Profile Page — Plan

Status: Phase 1 SHIPPED (8e1129d). Phases 2-3 planned. Explored 2026-07-12.

A signed-in user's home for everything they own on drumcorps.app: leagues,
favorite corps, notification subscriptions, bookmarked products, prediction
ballots, wiki contributions — plus account management (name, timezone,
delete account) and settings.

## 0. What exists today (exploration findings)

Storage classes matter — they decide what a profile page can show per-account
vs per-device:

| Feature | Storage | Query path today |
|---|---|---|
| Identity (name/email/image/role/timeZone) | `"user"` table, contributions.db (better-auth) | `getActor` (authz.ts); admin-only mutations |
| Fantasy leagues | `fantasy_leagues`/`fantasy_members` (+9 tables) | `listMyLeagues` server-fn — **exists, anonymous-safe** |
| Score notifications | `score_notify_subscriptions` (email identity, `user_id` nullable), `score_push_subscriptions` | subscribe/unsubscribe fns; **no "list mine"** (deliberate email-enumeration guard); localStorage token per target |
| Prediction ballots | `prediction_ballots` (user_id) | `myBallots` server-fn — **exists** |
| Wiki contributions | `show_revisions.author_id` (append-only), `show_stewards`, `profile_claims`, `show_media.uploaded_by` | admin moderation feed only; **no "by user" fn** |
| Favorite corps | `cp_fav` cookie — **single corps, device-local**, drives accent/favicon | favorite-corps-store + favorite-cookie.ts |
| Shop bookmarks | `localStorage['corps-place-merch-bookmarks']` — **device-local** | bookmark-store.ts; /shop/bookmarks page exists |
| Theme | `cp_theme` cookie — device-local | theme-store |
| Timezone | `user.timeZone` (IANA) — used for **emails only** | `setTimeZone` server-fn (consent.ts) — **exists** |

Auth: better-auth, Google OAuth + magic-link + passkey plugins, contributions.db.
`updateUser`/`changeEmail`/`deleteUser` are NOT enabled in auth.ts; the
established mutation pattern is `getActor`-gated server-fns doing raw UPDATEs
(see consent.ts `setTimeZone`, `acceptTerms`). Admin console already has
`exportUserData` + `anonymizeUser` (GDPR) in admin-users.ts.

Navigation: no user menu exists. Sign-in buttons are contextual; sign-out is a
footer link on the homepage. Site nav is an icon rail (desktop) + bottom tabs
(mobile) in `app/components/site-nav.tsx`.

## 1. Design decisions

**D1 — Route: `/account` layout with nested tab routes.**
`/account` (overview) + `/account/{leagues,notifications,bookmarks,ballots,contributions,settings}`.
File-based nesting gives each tab its own loader (lazy data, no giant payload)
and URL-addressable tabs. Signed-out visitors get a sign-in card (same pattern
as /fantasy). SSR must NOT be edge-cached: `/account` is per-user — the CF HTML
cache rule matches specific prefixes and `/account` is simply not added
(signed-in users bypass via cookie guard anyway, but don't rely on it alone).

**D2 — Identity mutations via server-fns, not better-auth endpoints.**
Follow the consent.ts pattern (getActor + validated raw UPDATE) for:
`updateAccountName`, `setTimeZone` (exists), notification prefs. Rationale:
consistent authz/audit story, no new better-auth config surface, and
name-from-Google can be overridden locally without fighting OAuth profile sync.
Email change is OUT of scope (email is the identity key for magic links and
score subscriptions; changing it safely is its own project).

**D3 — Delete account = self-service anonymize.**
Reuse the logic of admin-users.ts `anonymizeUser` as a new `deleteMyAccount`
server-fn (getActor, no capability needed — self only): anonymize the user row
(name → "Deleted user", email → tombstone, image NULL), delete sessions/
accounts/passkeys, delete score subscriptions + push endpoints + fantasy push
subs, remove league memberships (transfer or delete owned leagues — see Open
Questions), keep `show_revisions` rows (append-only wiki history stays intact,
attributed to the anonymized id). Hard confirmation UI (type "delete"), then
`signOut()` client-side. Also offer "Download my data" wired to a self-service
variant of `exportUserData`.

**D4 — Device-local data (favorites, bookmarks, theme): surface honestly in
Phase 1, sync in Phase 2.**
Phase 1 shows them on the profile with a "this device" badge — zero migration
risk. Phase 2 adds one `user_preferences` table (user_id PK, prefs_json,
updated_at) and a small sync layer: on sign-in, merge local → server (union for
bookmarks, server-wins for scalar prefs); stores subscribe to both. This makes
favorites/bookmarks roam across devices without breaking the cookie fast-path
(`cp_fav` stays the SSR accent-color source; the server copy is just the
backup/roaming source).

**D5 — "My notification subscriptions" listing is safe if scoped to the
session's own verified email.** The enumeration guard exists because the
subscribe dialog is anonymous. A `listMyScoreSubscriptions` server-fn that
queries `WHERE user_id = ? OR email = ?` using ONLY `getActor` identity leaks
nothing (you can only see rows for the email you're signed in as). Also: make
`subscribeScores` stamp `user_id` when signed in (it already does) AND add a
one-time backfill linking existing rows by email on first profile visit.
Management actions reuse the existing unsubscribe-token path.

**D6 — Timezone becomes a real display setting (Phase 3).**
`user.timeZone` already exists for emails. Extend to display: a Settings toggle
"Show event times in my timezone" (default OFF — venue-local stays the default,
it's what the activity expects). When ON, lineup-schedule converts venue-local
times using the event tz; requires storing an IANA zone per event (we only have
the ET/CT/MT/PT abbreviation today → map abbrev → IANA is trivial for US
zones). Signed-out fallback: `Intl.DateTimeFormat` auto-detect, no persistence.

**D7 — Nav: avatar user-menu.**
Add an avatar (or sign-in icon) entry to the site-nav rail + mobile tab bar
"More" position: menu = Profile, Settings, Admin (role-gated), Log out. Replace
the homepage footer log-out. Cookie-gate the session fetch like ConsentGate
(`maybeSignedIn`) so public pages don't pay a session lookup.

## 2. Page structure

```
/account                      Overview: identity card (avatar, name, email,
                              role badge, member-since) + summary tiles that
                              deep-link to each tab (league count, subscription
                              count, ballot count, contribution count,
                              favorite corps, bookmark count)
/account/leagues              listMyLeagues → league cards (role, corps name,
                              standing, season) → link to /fantasy/$slug;
                              per-league notify_email/notify_push toggles
                              (reuse fantasy notification-prefs component)
/account/notifications        listMyScoreSubscriptions → rows (target label,
                              kind, methods) with unsubscribe + method toggles;
                              push-device section (register/remove this device,
                              reuse score-notify-button's push logic);
                              admin-only: ingest-alert subscription state
/account/bookmarks            Reuse /shop/bookmarks grid inline ("this device"
                              badge until D4 Phase 2 sync)
/account/ballots              myBallots → list (title, season, preset, locked
                              date, grade once results exist) → /predict pages
/account/contributions        New listMyContributions: show_revisions by
                              author_id (op, target, summary, date, link to
                              show page + history), steward roles, profile
                              claims (from profile-owner overlay), uploaded
                              media count
/account/profiles             Staff/judge public-profile ownership (the
                              profile-owner system): list my claimed profiles
                              (from profile_claims by user_id, joined to the
                              staff/judge read-model row for name/photo/link),
                              claim status (pending/approved/rejected +
                              attestation date), quick actions — edit my
                              profile (deep-link to the public page, which
                              already hosts the owner editing UI:
                              saveProfileField/setProfilePhoto), revoke claim
                              (revokeProfileClaim), request removal
                              (deleteProfile). Also an entry point: "Are you
                              staff or a judge? Find your page" → /staff//judges
                              search (claiming itself stays ON the public page
                              where name-match attestation runs). Moderators
                              additionally see a link to the admin claims queue.
/account/settings             Name (updateAccountName), timezone picker
                              (setTimeZone — IANA select w/ auto-detect
                              button), theme (device), favorite corps (device,
                              link to /corps to change), contact consent
                              toggle, Download my data, Danger zone: delete
                              account
```

## 3. New server-fns (all `getActor`-gated, in `app/lib/server-fns/account.ts`)

- `getMyAccountOverview` — identity + counts (one batched query set; keep it
  <1 rt: counts via 5 cheap indexed COUNT(*)s in contributions.db)
- `updateAccountName(name)` — valibot 1..80 chars, raw UPDATE
- `listMyScoreSubscriptions` / `updateScoreSubscriptionMethods(id, methods)` /
  self-unsubscribe (by id, ownership-checked — not the public token path)
- `listMyContributions(cursor?)` — show_revisions by author_id, paginated 50
- `listMyProfileClaims` — profile_claims by user_id (status, kind, target
  slug/name, claimed_at) joined to the staff/judge read-model for display name +
  photo; powers /account/profiles. Mutations reuse the EXISTING profile-owner
  fns (revokeProfileClaim, deleteProfile) — no new mutation surface, so the
  attestation/rate-limit/moderation invariants stay in one place
- `deleteMyAccount(confirmText)` + `exportMyData` (self-service variants of the
  admin fns; share the implementation, different gate)
- Phase 2: `getMyPreferences` / `saveMyPreferences(prefsJson)` (user_preferences)

Existing fns reused as-is: `listMyLeagues`, `myBallots`, `setTimeZone`,
`getProfileOverlay` (claims), fantasy notification prefs.

## 4. Phases

**Phase 1 — Core page (ship first).**
Route skeleton + nav avatar menu; Overview; Leagues; Ballots; Bookmarks
(device); Settings with name + timezone + theme + consent; server-fns
`getMyAccountOverview`, `updateAccountName`. No schema changes.

**Phase 2 — Notifications + Contributions + Profiles + account lifecycle.**
`listMyScoreSubscriptions` (+ email→user_id backfill), management UI, push
device management; `listMyContributions`; `/account/profiles` staff/judge
profile-ownership tab (`listMyProfileClaims` + existing profile-owner
mutations); `deleteMyAccount` + `exportMyData` with confirmation flows.
Delete-account interaction: revoke the user's profile claims (claims are
personal attestations — they don't survive anonymization) but leave approved
field overrides/photos in place (they're public content, like wiki edits).
Schema change: none (all tables exist).

**Phase 3 — Sync + timezone display.**
`user_preferences` table + favorites/bookmarks roaming (D4); "times in my
timezone" display option (D6, needs abbrev→IANA per event); optional multiple
favorite corps (store is single-slot today — schema is versioned, bump to v3).

## 5. Perf & safety notes

- Every tab loads its own data via its own route loader — the Overview payload
  is counts only. No account data is edge-cacheable; do not add /account to the
  CF cache rule, and stamp `cache-control: no-store` on account server-fns
  (they're under /_serverFn/account_* — NOT the hybrid prefix, so the SW and CF
  rules already bypass them; verify).
- The SW must not cache /account documents: it uses NetworkFirst for docs, so
  offline shows stale account pages — acceptable, but confirm signed-out
  transitions clear it (existing kill-switch handles SW-off).
- Delete-account must also purge the user's push endpoints (both tables) or
  they'll keep receiving pushes as "ghosts".
- Rate-limit `updateAccountName` (same in-memory limiter as claimProfile).
- Bundle: the account routes must be their own chunks (default file-based
  splitting handles it); don't import fantasy runtime at module scope (use the
  lazy `import('@/rpc')` pattern — see fantasy.ts precedent).

## 6. Open questions (decide before Phase 2)

1. Deleting an account that OWNS a fantasy league mid-season: transfer to
   oldest member, or block deletion until season ends? (Recommend: transfer,
   with email to the new owner.)
2. Should wiki contributions remain publicly attributed by name after account
   deletion, or show "Deleted user"? (Recommend: "Deleted user" — matches
   anonymizeUser behavior.)
3. Multiple favorite corps (Phase 3) — the entire accent/favicon system assumes
   one; multiple favorites = "primary" + list, only primary drives theming?
