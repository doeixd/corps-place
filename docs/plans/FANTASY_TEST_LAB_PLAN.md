# Fantasy Test Lab — plan

**Goal.** Let a site admin fully exercise the fantasy features — quiz → draft room →
standings → notifications — end-to-end, alone, in an isolated **test league**, without
needing N real accounts, without waiting on real-time timers or real recap data, and
without polluting real data or emailing real people. All behind the existing
`manageFantasyLeagues` (admin) capability.

---

## What already exists (build on it, don't reinvent)

- **Admin ops** (`app/lib/server-fns/admin-fantasy.ts`, gated `manageFantasyLeagues`):
  `adminListLeagues`, `adminGetLeague`, `adminPauseDraft`, `adminResumeDraft`,
  `adminCancelLeague`, `adminTakedownIdentity`, `adminRecomputeStandings`.
  Admin routes: `/admin/fantasy/leagues`, `/admin/fantasy/quiz`.
- **Quiz bank editor**: `/fantasy/quiz-admin` (add/edit/activate questions) +
  `adminListQuestions` / `adminSetQuestionActive`.
- **Draft engine** is fully simulated in tests (`draft-service.integration.test.ts`) —
  the auto-pick logic can fill any seat deterministically by prior-season rank/queue.
- **Impersonation**: better-auth admin plugin (`authClient.admin.impersonateUser`) —
  an admin can become any user (an alternative to bots for manual multi-seat testing).
- **Read-model** `rm_fantasy_*` (draft pool, prior finals, season-best, finals) is live
  in prod, so the draft pool + auto-pick ranking already work for a test league.

## The gaps

1. No **test-league / bot-user** concept — testing the draft needs ≥2 members with
   identities; today that means ≥2 real logged-in humans.
2. `makePick` always uses the **caller's** identity — an admin can't pick for other seats.
3. Draft is **real-time** (60s timers, a scheduled start) — no way to fast-forward.
4. **Standings** need scored competitions — no way to inject synthetic scores to see a
   populated/finalized table on demand.
5. The **quiz bank may be empty** in prod — no seed, so the quiz can't be taken.
6. No **teardown** — test data would linger and pollute real lists/stats/standings cron.

---

## Design principles

- **Isolation & prod-safety first.** A test league is flagged `is_test = 1`; bot users
  are flagged `is_bot = 1`. Test leagues are **excluded** from: the real standings
  recompute cron, the notification dispatch to real addresses, public/league lists, and
  the admin consent/notification stats. Bots have **no real email** (so the consent +
  email gates already make them un-emailable). Everything is clearly **badged "TEST"**.
- **Reuse the engine.** Bots pick via the existing auto-pick logic; standings via the
  existing recompute. The lab is mostly orchestration + seeding, not new game logic.
- **One capability.** Every lab action calls `requireCapability(..., 'manageFantasyLeagues')`.
- **Code-split safe.** All new server-fns follow the handler-only pattern (no module-scope
  service/Live holders) — the recurring bundle-leak trap. Verify the client `main` chunk
  after deploy.
- **Reversible.** Every seed action has a matching teardown; "Delete test league" cascades.

---

## Phases

### Phase 0 — Safety rails (foundation; do first)
- Migration: `fantasy_leagues.is_test INTEGER DEFAULT 0`, `user.isBot INTEGER DEFAULT 0`.
- Exclude `is_test` leagues from: standings recompute cron (`recompute` season sweep),
  notification dispatch, `listMyLeagues`/public surfaces (unless the viewer is the admin
  owner), and the admin consent/notification counts.
- A small **"TEST"** badge wherever a test league is shown.
- **Acceptance:** a flagged league never triggers a real email/push, never appears in
  another user's lists, and is skipped by the cron.

### Phase 1 — Seed a test league in one click
- `adminCreateTestLeague({ memberCount, withQuizScores, draftType, captionCaps, pickSeconds })`:
  creates an `is_test` league owned by the admin + `memberCount` **bot members**
  (synthetic `isBot` users with names, corps names, colors, optional quiz scores +
  draft positions). Returns the slug.
- **Acceptance:** one call yields a ready-to-draft league the admin can open.

### Phase 2 — Quiz testing
- `adminSeedQuizQuestions` — insert a starter bank of sample drum-corps questions
  (idempotent) so the quiz is non-empty.
- `adminResetMyQuizAttempt(leagueId)` — clear the admin's attempt to re-take.
- Bots get synthetic scores at seed time (Phase 1).
- **Acceptance:** admin can take the quiz, see scoring, and re-take.

### Phase 3 — Draft room testing (the core)
- `adminMakePickFor({ leagueId, userId, corpsKey, caption })` — pick on behalf of a bot
  seat (admin-authority variant of `makePick`).
- `adminAutoPickCurrent(leagueId)` — make the current on-clock seat's best legal pick now
  (drives bots through their turns without waiting).
- `adminFastForwardDraft(leagueId)` — run auto-pick repeatedly until the draft completes.
- `adminSkipPickTimer(leagueId)` — set the current deadline to now (exercise the auto-pick
  timer path immediately).
- `adminStartDraftNow(leagueId)` — bypass the scheduled time.
- **Acceptance:** admin opens the draft room, makes their own picks, clicks "auto-pick for
  the bots" each turn (or "fast-forward"), and watches it complete live (SSE).

### Phase 4 — Standings testing
- `adminSeedSyntheticScores(leagueId)` — write plausible fake caption scores for the
  drafted corps so `recompute` produces a populated table immediately (no waiting on real
  recaps), with a "mark finals landed → final/locked" option.
- Reuse `adminRecomputeStandings`.
- **Acceptance:** admin sees a live standings table, then a finalized/locked one.

### Phase 5 — Test Lab UI + teardown
- `/admin/fantasy/test-lab`: create-test-league form; list of test leagues with quick
  links (home/quiz/draft/standings) and buttons (seed scores, start now, auto-pick,
  fast-forward, recompute, mark final); **Delete test league** (cascades picks, standings,
  members, draft, scheduled jobs, notifications, and orphan bot users).
- **Acceptance:** an admin can spin up, drive, inspect, and tear down a full test league
  from one page.

### Phase 6 — Notification preview (optional)
- `adminSendTestNotification({ kind, channel })` — send any lifecycle email/push template
  to the admin only, to preview copy without a real draft.

---

## Sequencing & risk

- **Order:** 0 → 1 → 3 → 2 → 4 → 5 → 6. Phase 0 is non-negotiable first (prevents test
  data from leaking into prod behavior). Phase 3 is the highest-value/most-effort.
- **Smallest useful slice (MVP):** Phases 0 + 1 + 3 (`adminAutoPickCurrent` /
  `adminFastForwardDraft`) — that alone lets an admin watch a full draft solo.
- **Each phase ships independently** behind the admin cap, with the post-deploy client
  `main`-chunk leak check.
- **Teardown is a feature, not a footnote** — without Phase 5's delete, the test data
  accumulates and Phase 0's exclusions are the only thing keeping prod clean.

## Open questions for the owner

1. **Bots vs impersonation** for the *other* seats: synthetic bot users (self-contained,
   no second login) vs. impersonating real test accounts (more realistic SSE/multi-tab).
   Recommend **bots** as the default, impersonation as a manual extra.
2. **Synthetic vs real scores** for standings: fake injected scores (instant, deterministic)
   vs. recompute against the real season's data once it has results. Recommend **both** —
   synthetic for on-demand testing, real as a sanity check.
3. Should test leagues be **visible to all admins** or only their creator? Recommend
   visible to any `manageFantasyLeagues` holder (shared lab).
