# Fantasy DCI — UI/UX Overhaul & Productionization Plan

Status: **DRAFT for review** · Created: 2026-06-23 · Owner: TBD

Companion to the two existing fantasy plans — the feature spec
(`FANTASY_DCI_PLAN.md`) and the backend migration
(`FANTASY_EFFECT_TANSTACKDB_MIGRATION_PLAN.md`). This plan covers **everything the
user sees**: fixing the production-breaking bugs surfaced once the feature went
live behind `VITE_ENABLE_FANTASY=true`, then a full UX/visual overhaul of every
fantasy surface, a new **league image** feature, a polished **shared photo-upload
component**, a **navigation redesign**, and an **invite-flow** rework
(auto-generate + share + explain + join-once).

The feature shipped functionally but **looks prototype-ish: unorganized,
confusing, unpolished**, and two flows are actually broken in prod (draft room
500; push toggle). This plan makes it feel like a real product.

---

## 0. TL;DR

- **Two prod bugs block real use and must go first** (§2): the **draft room 500s**
  because the scoring/relational DB (`dci-relational.db`) isn't on the prod
  request path, and **push notifications are dead** (no VAPID keys) so the
  "Enable draft alerts" button can't work.
- **Everything is bare**: no icons, no motion, no skeletons, terse copy, no
  onboarding/explainers, jargon never defined (caption, GE/Visual/Music, seeding,
  recap), and the per-league pages have no real **navigation** — just three
  underlined text links. §3–§4 rebuild the design language, navigation, and copy.
- **New: a league image** (upload a picture to represent the league) + a single
  **`<PhotoUpload>`** component (drag/drop, preview, progress, validation, errors,
  optional crop) that replaces every ad-hoc file input (corps logo, league image,
  and reconciles with the contrib `ImageDrop`). §5.
- **Invite flow rework** (§6): generate the invite link **by default** (no
  button), add a **native Share** button + copy, **explain what it's for**, and
  make joining **idempotent/once-only** (already enforced by the PK + race-safe
  accept — surface it gracefully).
- **Mobile-first** throughout (§3.5): the league sub-nav, draft room, and
  standings table are the weak spots.

---

## 1. Goals & Non-Goals

### Goals
1. Fix the production-breaking bugs so the feature actually works end-to-end in
   prod (draft, push).
2. Make the fantasy area look and feel **polished, organized, and self-explanatory**
   — a new user understands what it is, what to do next, and what the jargon means.
3. Add a **league image** + a reusable, polished **photo-upload** component.
4. Redesign **navigation** (global entry + per-league tabs).
5. Rework the **invite** UX (default link, share, explain, join-once).
6. First-class **mobile** experience.

### Non-Goals (this pass)
- No new game mechanics (no trades, chat, public discovery, multi-season history).
- No change to the scoring math or draft rules (those are correct + tested).
- Not flipping `FANTASY_EFFECT_DRAFT` on — that's the migration plan's concern;
  this plan works with whichever engine is active.

---

## 2. CRITICAL — production bugs (fix BEFORE the cosmetic work)

These were found by inspecting the live prod box after launch. They make the
feature look broken regardless of polish.

### 2.1 Draft room 500 — scoring data is not on the prod request path  ⚠️ biggest

**Symptom:** opening `/fantasy/$slug/draft` returns a 500.

**Root cause:** the draft room loader (`getDraftState`) calls `getDraftPool()`
(`app/lib/fantasy/score-db.ts`), which reads **`dci-relational.db`**. In prod that
DB is **deliberately absent** — the serving image ships only the read-model +
contributions + media-cache (`/data/read-model*.db`, `/data/contributions.db`),
**not** the 3.6 GB relational DB (see `docs/READ_MODEL_PLAN.md` /
`DEPLOYMENT_REALITY.md`). `DCI_RELATIONAL_DB_URL` is unset in prod, so `score-db.ts`
falls back to `file:.../sdk/dci-relational.db`, which doesn't exist → the corps
query throws → 500.

**Everything that touches `score-db.ts` is broken in prod**, not just the draft:
- `getDraftPool` — draft room + pick legality (request path) → **500 now**
- `getPriorSeasonRanking` — auto-pick ranking (request path, when the clock fires)
- `getSeasonBestLookup` / `getSeasonFinals` — standings **recompute** + the
  config weights-lock (`updateLeagueConfig`). Recompute is a cron HTTP route that
  also runs **in the container**, so it would fail in prod too.
- Standings **display** (`getStandings`) still works — it reads `fantasy_standings`
  from contributions.db, which IS in prod. So leagues/quiz/standings-view look
  fine, but **draft + scoring recompute are dead in prod**.

**Fix (recommended): put the small fantasy slices into the read-model.** Mirror
the app-wide pattern (`app/lib/read-model-db.ts`: read `rm_*` when
`READ_MODEL_DB_URL` is set, fall back to `dci-relational.db` in dev). Emit:
- `rm_fantasy_draft_pool(season, corps_key, slug, name, division_name,
  display_city, corps_logo)` — active World/Open corps per season (Appendix C.4).
- `rm_fantasy_prior_finals(season, corps_key, caption, score)` — prior-season WC
  finals caption scores for auto-pick ranking (C.3).
- `rm_fantasy_season_best(season, corps_key, caption, best)` — season-best to date
  (C.2), refreshed by the same emit that runs after each scrape.
- `rm_fantasy_season_finals(season, slug, date, recap_present)` — finals detection
  (§5.5 / weights lock).

Then rewrite `score-db.ts`'s four readers to use `getReadModelClient()` when
`readModelEnabled()`, else the relational DB (dev). Add these tables to
`emitReadModel.ts` (+ bump `SCHEMA_VERSION`) and `readers.ts`/builders so they ship
with every read-model push (the existing pull-from-R2 → `/data` pipeline then
carries them to prod automatically).

**Alternatives considered** (document, don't pick blindly):
- Point `DCI_RELATIONAL_DB_URL` at a copy in `/data` — rejected (3.6 GB on the
  request path; defeats the read-model design; per memory `no-local-builds…` the
  box is RAM-constrained).
- Run **recompute** as a box-side `npx tsx` cron (where `dci-relational.db`
  exists) instead of the container HTTP route — viable for recompute, but does
  **not** fix the request-path reads (draft pool, auto-pick), so the read-model
  emit is still needed. Keep recompute as a route reading the read-model for
  consistency.

**Acceptance:** `/fantasy/$slug/draft` returns 200 in prod; a draft can be
scheduled, started, picked, completed; standings recompute runs in-container; no
`dci-relational.db` access on the request path.

### 2.2 Push notifications dead in prod + the lone toggle is confusing

**Symptom:** the "Enable draft alerts" button sits by itself on the league
dashboard, looks out of place, and doesn't work.

**Root cause:** no `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` set
in prod → `getVapidPublicKey()` returns null → the toggle can't subscribe. The
component renders anyway (only gated on service-worker availability, not on push
being configured).

**Fix:**
1. **Gate the toggle on push being configured** — hide `PushToggle` when
   `getVapidPublicKey()` is null (and when `Notification`/SW is unavailable), so it
   never shows as a dead control.
2. **Generate + set VAPID keys** in Coolify prod (`npx web-push generate-vapid-keys`
   → `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT=mailto:…`, runtime vars,
   no rebuild needed for runtime). Then push works.
3. **Reposition + explain** (§4.3): move it out of a lone card into a "Notifications"
   row in the league settings/section, with copy ("Get a push when your pick is on
   the clock") and a clear enabled/disabled state + success confirmation.

**Acceptance:** the toggle only appears when push is actually available; enabling
it subscribes and shows confirmation; a draft-soon / on-the-clock push is received.

> Note: `getDraftState` runs in the **route loader** (SSR), so this is a
> server-side 500 on first paint, not a client fetch — there's no graceful
> client fallback today. The route `head` also reads `loaderData.league.…`, so a
> loader throw takes the whole page down.

### 2.3 Prod safety net (this class of bug must not recur)
The draft 500 reached prod **only because `VITE_ENABLE_FANTASY` was flipped on
without a live end-to-end pass** (the §10 discipline from the migration plan was
skipped). Bake the lesson in:
- **Sweep** for any other request-path read of `dci-relational.db` /
  `score-db.ts` under `app/**/fantasy*` and route it through the read-model (§2.1).
- **Prod data-source healthcheck**: a tiny endpoint/script that asserts the
  fantasy data source (draft pool, season-best) is actually reachable in the
  serving environment, and fails loudly — wire it into the deploy healthcheck or a
  post-deploy smoke check so a missing source is caught before users hit it.
- **Mandatory dev E2E before enabling on prod**: enable on `dev.drumcorps.app`
  first and click through create→invite→quiz→**draft**→standings (the draft is the
  step that exercises the score DB). Only then flip prod. Add this to the deploy
  runbook.
- **Surface server errors**: today a fantasy 500 leaves no trace in the app logs
  (see §3.8) — fix observability so the *next* one is visible immediately.

---

## 3. UX foundations (cross-cutting — apply everywhere)

The whole area reads as a prototype. These foundations are reused by every page in
§4.

### 3.1 Design language & polish
- **Cards over bare borders.** Replace the ad-hoc `<Link>`/`<div>` lists (index,
  members, pool, rosters) with the `Card` family + the established `.card-hover` /
  `.card-hover-flat` / `.icon-shift` classes (AGENTS.md) for hover lift + arrow
  nudge.
- **Icons everywhere** via the `<Icon>` wrapper + Hugeicons (`~icons/hugeicons/*`):
  trophy/ranking for leagues, calendar for schedule, clock for the draft timer,
  users for members, shield for caption, sparkles for quiz, etc. Currently the
  fantasy area uses **zero** icons (only the spinner).
- **Status as `Badge`** (not muted text). A keyed `STATUS_BADGE` map
  (setup/quiz/scheduled/drafting/active/complete/canceled → variant + label +
  icon), mirroring the `CATEGORY_BADGE`/`READINESS_CHIPS` pattern.
- **Motion** (`motion/react`): list item enter/exit (`AnimatePresence`,
  `initial={false}` to avoid SSR FOUC), pick/standings row updates, the draft clock.
  Drive variants off XState `snapshot.matches` where a machine exists.
- **Empty states with personality**: icon + headline + one-line explainer + a
  primary action, not a bare sentence.

### 3.2 Navigation redesign (the "Quiz / Draft / Standings" problem)
Today a league page exposes navigation as **three underlined text links** in the
header — easy to miss, no active state, no hierarchy.

- **Per-league sub-nav / tab bar**: a proper segmented control / tab strip under
  the league header — **Overview · Quiz · Draft · Standings · Members · Settings**
  — with the active tab highlighted, icons, and a disabled/locked state with a
  tooltip when a step isn't available yet (e.g., Draft locked until scheduled,
  Standings locked until the first recap). On mobile it becomes a horizontally
  scrollable pill row or a bottom segmented control.
- **Breadcrumb / back affordance**: `Fantasy → {League name} → {Tab}` so users can
  always get back. The current "League" outline button is inconsistent.
- **Global nav**: the single "Fantasy" item is fine; consider a small dropdown /
  recent-leagues quick-switcher once a user has multiple leagues.
- **Route-aware**: drive the active tab from the route, not local state.

### 3.3 Onboarding, explainers & glossary
- **`/fantasy` landing explainer** (§4.1): a short "How it works" — *Draft
  per-caption scores from real corps → earn points from real recaps → climb the
  standings*, with a 4-step visual (Create → Invite → Quiz → Draft → Standings).
- **Contextual help**: a `?`/info `Popover`/`Tooltip` next to jargon (caption,
  GE/Visual/Music, seeding, recap, weights). One shared `<Explain term="caption"/>`
  component backed by a glossary map so copy stays consistent.
- **Per-status guidance**: each league status renders a one-line "what to do now"
  banner ("Quiz is open — take it before the draft to improve your pick order").
- **A "Getting started" checklist** on the dashboard for owners (name your corps →
  invite → schedule the draft) and members (name your corps → take the quiz → be
  in the room at draft time), with checkmarks.
- **A dedicated help/FAQ surface** ("answer questions" — explicit ask): a
  `/fantasy/how-it-works` (or a slide-over `Sheet` reachable from every fantasy
  page via a persistent `?` button) that explains the whole game — leagues,
  invites, the quiz/seeding, the draft + captions, scoring + recaps, standings,
  finals lock — with the glossary inline. Reuse/expand the one-line FAQ entry in
  `app/routes/faq.tsx`. SSR'd, shareable, linkable from empty states.
- **Live "what's happening now" narration** ("explain what's going on" — explicit
  ask): every league/draft view shows a single, plain-language status line driven
  by the current state, e.g. *"Waiting for the owner to schedule the draft."* /
  *"Quiz is open — 3 of 6 members have taken it."* / *"Draft starts in 1h 12m —
  you're seeded #2."* / *"On the clock: Phantom Regiment (you're up in 2 picks)."*
  / *"Season in progress — standings update after each scored show."* Centralize
  this in a pure `describeLeagueState(league, draft, viewer)` selector + a
  `<StatusNarration>` component so the copy is consistent and testable.

### 3.4 Loading / empty / error states
- **Skeletons** for the read pages (index, dashboard, standings) during hydration
  instead of nothing — use the `Skeleton` component + the `<HybridCollection>` /
  `<HybridRecord>` SSR handoff already in place. Use `useDelayedFlag(active, 250)`
  to avoid spinner flashes.
- **Errors with recovery**: replace raw `destructive` text with an `Alert` +
  retry, and map the boundary error strings (`legacyFantasyMessage`) to friendly,
  actionable copy (already centralized via `matchMessage`; expand the dictionaries).
- **Optimistic UI** for picks / identity save via the collections' `refetch` +
  `useOptimistic` where it reads well.

### 3.5 Mobile-first (call out the weak spots)
- **League sub-nav** → scrollable pills / bottom segmented control (§3.2).
- **Draft room** → the `md:grid-cols-[2fr_1fr]` split stacks on mobile, but the
  pool's `max-h-[60vh]` pushes the roster off-screen. Rework to tabs (Pool /
  Rosters / Clock) or a sticky clock + collapsible roster; make caption pick
  buttons thumb-sized; sticky "on the clock" header.
- **Standings table** → horizontal scroll is rough with many caption columns. On
  mobile, collapse to a card-per-player view (rank, corps, total) with an
  expandable per-caption breakdown, instead of a wide table.
- Respect the `pb-bottom-nav` / `pl-side-nav` spacing tokens so content never
  hides behind the bottom nav.
- Touch targets ≥ 44px; the current inline caption buttons and "Edit" links are
  too small.

### 3.6 Copy & tone
- Replace terse strings ("Sign in to play", "You get one timed attempt") with warm,
  specific copy that states the *why* and the *consequence*.
- Define every term on first use; never show a bare abbreviation (GE/VP/CG…)
  without a tooltip or legend.
- Confirmations after meaningful actions (league created, identity saved, invite
  copied, quiz submitted) via a toast/inline success, not a silent navigation.

### 3.7 Accessibility (first-class, not an afterthought)
- **Keyboard**: the per-league tab nav (roving tabindex / arrow keys), the draft
  pick buttons, inline rename, and the photo uploader must be fully keyboard
  operable; visible focus rings throughout.
- **Screen readers**: label every control; the draft clock + "on the clock" and
  incoming picks announce via `aria-live` (polite) regions; the standings table
  has proper `<caption>`/`scope` headers; status badges have text, not color-only.
- **Color contrast**: corps `corps_color` accents render on light **and** dark
  backgrounds (the app uses oklch theming) — never rely on the user-chosen color
  for contrast; pair it with a text label and a contrast-safe surface. Status
  badges meet AA.
- **Reduced motion**: gate the new `motion/react` animations on
  `prefers-reduced-motion`.
- **Timeouts**: the quiz/draft countdowns are time-pressure UI — provide clear
  warnings and don't trap keyboard users.

### 3.8 Observability (so the next prod bug is visible)
The draft 500 left **no trace in the app logs** — that's the real failure. Fix it:
- **Log server-fn / loader failures** with route + actor + the typed error (the
  Effect boundary already has `Effect.logError` for defects — ensure fantasy
  loaders/server-fns surface 500s to the container logs, not just to the client).
- **Client error boundary** for the fantasy route subtree → a friendly "something
  went wrong" + a report path, instead of a raw 500/blank.
- Consider lightweight client + server **error reporting** (even a structured log
  line shipped to the existing logging) so a spike is noticed.
- A **fantasy health indicator** (data source reachable, push configured, payments
  configured) on an internal/admin page so ops can see config gaps at a glance
  (this would have shown "score DB: MISSING" and "VAPID: not set" immediately).

---

## 4. Per-surface redesign

### 4.1 `/fantasy` (index) — make it informative
Currently: a heading + a bare list (or one-line empty state). Rebuild as a real
landing:
- **Signed-out:** hero with a one-paragraph explainer + the 4-step "how it works"
  visual + a prominent "Sign in to play"; an example/teaser of a standings card so
  it's not abstract.
- **Signed-in, no leagues:** friendly empty state (icon + "Start your first
  league") + "Create a league" + "Have an invite link? Paste it here" affordance.
- **Signed-in, with leagues:** **league cards** (not text rows) showing the new
  **league image**, name, season, a **status `Badge`**, member count, your role,
  and a "next action" hint ("Draft starts in 2h" / "Take the quiz"). `card-hover` +
  `icon-shift` arrow. Sort by activity/status.
- A persistent "How it works" / FAQ link.

### 4.2 `/fantasy/create`
- Explain **season** (the DCI competition year) and **what a league is** inline
  (helper text under each field, not just placeholders).
- Show a **live preview** of the league card as you type (name + image).
- Add the **league image** upload here (optional at create; editable later) — §5.
- On success, route to the dashboard **with a success toast** + the getting-started
  checklist front-and-center.

### 4.3 `/fantasy/$slug` (dashboard) — the hub
- **League header** with the **league image** (banner/avatar), name, **status
  badge**, season, member count, and the **per-league tab bar** (§3.2) underneath.
- **Editable league name (owner).** The name is currently fixed at create time —
  make it **naturally editable in place**: the header name is an inline-editable
  field for the owner (click-to-edit / pencil affordance → input → Enter/blur to
  save, Esc to cancel; optimistic update via the detail collection's `refetch`).
  Validate like create (trim, 1–60 chars). Backend: add
  **`LeagueService.rename(actor, leagueId, name)`** (owner-gated, durable-guard) +
  a `renameLeague` server-fn shim — do NOT reuse `updateLeagueConfig` (that's
  config-only). **Keep the `slug` stable** on rename (don't re-slug) so existing
  URLs and invite links keep working; only the display `name` changes. The new
  name then propagates everywhere via the collections (index cards, header, join
  preview, standings/draft titles, emails). Non-owners see read-only.
- **Getting-started checklist** (§3.3) for the viewer's role.
- **Organized sections** (cards with icons + titles), not a flat stack:
  - *Your corps* (identity) — with inline preview, not a bare form (§5).
  - *Members* — polished roster cards (image, name, color, role badge), grid on
    desktop / list on mobile.
  - *Invite* (owner) — reworked per §6 (auto-generated link + share, explained).
  - *Notifications* — the push toggle, gated + explained (§2.2).
  - *Billing* (owner, if payments on) — keep, but icon + clearer states.
- Replace the three header text links with the tab bar.

### 4.4 Quiz (`/fantasy/$slug/quiz`)
- Up-front explainer: **why** the quiz exists and that **score → draft seeding
  (pick order)**, with an `<Explain term="seeding"/>`.
- **Progress bar** + question counter; one-question-at-a-time option on mobile;
  visible **time limit up front** (not a surprise countdown).
- Answer selection animation; disabled state after answering is clearer.
- **Completed:** show score **and** a short breakdown ("8/10 · sets your seed to
  #3 of 6"), with a clear next step ("Be in the draft room at {time}").
- Better pre-states (disabled/unavailable) with icons + "what to do".

### 4.5 Draft room (`/fantasy/$slug/draft`)  — after §2.1 fix
- **Explain captions** (GE/Visual/Music and the 8 sub-captions) with a legend +
  tooltips; never show bare abbreviations on pick buttons.
- **Clear turn/order**: "You're pick #5 of 8 · Round 2" + a visible snake-order
  strip; prominent "Your pick!" state + on-the-clock animation.
- **Auto-pick warning**: a visible "auto-pick in 0:08" affordance before it fires,
  and a clear marker on auto-picked rows.
- **Better pool**: sort (by name / division / prior-season rank) + filter, not just
  text search; show each corps' prior-season caption strength as a hint; group by
  division.
- **Mobile**: tabs (Clock / Pool / Rosters) or sticky clock + collapsible roster
  (§3.5); thumb-sized caption buttons.
- Keep the SSE live updates; add subtle motion on incoming picks.

### 4.6 Standings (`/fantasy/$slug/standings`)
- **Legend + tooltips** for GE/Visual/Music + each caption; explain **Total** vs
  the per-caption columns and the 3-decimal precision (or reduce to 2).
- **Highlight top 3** (medal styling via `medalClass`), your own row, and movement
  since last recap (▲/▼).
- **Mobile**: card-per-player with expandable breakdown (§3.5).
- Explain **"final"** vs **"live"** and link back to the draft/league.
- Empty state with the flow ("Standings appear after the draft + the first scored
  show").

### 4.7 Join / invite (`/fantasy/join/$token`)
- **Preview the league** before joining (image, name, member count, owner, draft
  schedule) so the decision is informed.
- Explain **what joining means** (you'll name a corps, take the quiz, draft).
- **Join-once** (§6): if already a member, skip straight into the league with a
  "You're already in this league" note instead of a confusing re-join.
- Friendlier invalid/expired/used-up/closed states (icon + reason + "ask the owner
  for a new link").

### 4.8 Quiz-admin (`/fantasy/quiz-admin`)
- Per-difficulty counts + balance hints (how many easy/medium/hard).
- A **live preview** of the question as a player sees it (no `correct_index`).
- Inline choice editor (add/remove rows) instead of a newline textarea.
- Search/filter/sort the bank; success toasts; empty-state copy.

### 4.9 League lifecycle & privacy (gaps surfaced during review)
- **Leave a league (member).** Today only the **owner** can `removeMember`; a
  member has no way to leave. Add a member-initiated "Leave league" (pre-draft;
  sets their `status='removed'`, frees their seat) with a confirm. Backend:
  `MembershipService.leave(actor, leagueId)` (self-only; not the owner — owners
  cancel/transfer instead).
- **Owner: cancel / transfer.** There's an admin `adminCancelLeague`, but the
  owner has no in-app "cancel league" or "transfer ownership". Add both
  (confirm-gated), so an owner isn't stuck.
- **Privacy / spectator view.** `getLeague` is **not** member-gated — anyone with
  the slug can see the league name + member roster. Decide the privacy model:
  either (a) gate the dashboard/standings to members + a tokened spectator link,
  or (b) intentionally allow a read-only spectator view (and design it). Either
  way, make it deliberate; add `noindex` to league/invite pages so private leagues
  aren't search-indexed.
- **Empty/off-season states.** If the draftable pool is empty (off-season / no
  active corps for the season) or no shows are scored yet, the draft and standings
  must degrade gracefully with an explainer, not an error or a blank.

---

## 5. New: league image + a unified photo-upload component

### 5.1 League image (the requested feature)
"Upload a picture to represent the league."
- **Schema:** add `logo_media_id TEXT` (and/or `cover_media_id`) to
  `fantasy_leagues` (append a `ALTER TABLE … ADD COLUMN` via the existing
  idempotent `ensureColumns` path in `contributions-db.ts` — do NOT drop/recreate).
- **Service:** reuse the Effect **`MediaService.uploadLogo`** (already built;
  sharp→WebP→R2→`fantasy_media`) — generalize it to accept a `kind`
  ('league' | 'corps') or add `MediaService.uploadLeagueImage(actor, leagueId,
  dataBase64)` with an **owner** guard (vs the member guard for corps logos). Store
  the `media_id` on `fantasy_leagues.logo_media_id` (owner-gated mutation on
  `LeagueService`).
- **Serve:** reuse `/api/fantasy-media/$id` (already exists).
- **UI:** league-image upload on `/fantasy/create` (optional) and in the dashboard
  header / settings; shown on the index league cards, dashboard header, and the
  join/preview page. Sensible default (initials/monogram or a generated gradient)
  when unset.

### 5.2 Shared `<PhotoUpload>` component (better photo upload UX)
Replace the three ad-hoc paths (corps logo file-input in `CorpsIdentityForm`, the
new league image, and reconcile with contrib's `ImageDrop`) with one polished,
reusable component under `app/components/` (e.g. `photo-upload.tsx`):
- **Drag-and-drop** + click-to-pick + paste-from-clipboard.
- **Preview** (the selected image) before/after upload; **replace/remove**.
- **Client-side validation**: type (image/*), size (mirror the 8 MB server cap),
  dimensions; friendly inline errors (the server now returns typed `MediaInvalid`
  messages — surface them verbatim).
- **Progress / busy** state (not just "Uploading…" text); disabled while busy.
- **Optional crop / aspect** (square avatar for corps/league logo; wide banner for
  a league cover) — a lightweight cropper or fixed aspect framing.
- **Accessible**: keyboard, labelled, focus states; respects reduced motion.
- **Effect-free client**: base64 → the `uploadFantasyLogo`/league-image server-fn
  (the server-fn split keeps Effect/sharp/R2 off the client bundle).
- Props: `{ value, onUploaded, kind: 'corps'|'league', aspect?, maxBytes?,
  leagueId }`. Use it in `CorpsIdentityForm`, the league create/settings, and
  (optionally) migrate contrib's `ImageDrop` callers to it later to converge on one
  uploader.

---

## 6. Invite UX rework

The user's explicit asks, plus the join-once guarantee:

- **Generate the invite link by default — no button.** When an owner opens the
  league (or the Invite section), mint (or reuse the latest valid) invite link
  automatically and show it ready-to-share. Avoid minting a fresh token on every
  view: reuse the most recent non-revoked, non-expired, non-used-up invite for the
  league; only mint when none exists. (Add `InviteService.getOrCreateShareLink`.)
- **Share button.** A native **`navigator.share()`** button (with graceful
  fallback to copy on unsupported browsers), plus the existing copy-to-clipboard.
  Optional: a QR code for in-person sharing.
- **Explain what it's for.** Copy next to the link: "Share this link to invite
  friends. Anyone with it can join {league} until the draft starts." Show expiry +
  remaining uses.
- **Join-once (already mostly enforced — surface it):** the
  `fantasy_members (league_id, user_id)` **PRIMARY KEY** + the race-safe
  `acceptInvite` (atomic `used_count` CAS, "already active → no-op `already:true`")
  already prevent a user joining twice or double-consuming a seat. The work is
  **UX**: on the join page, if the viewer is already a member, route them straight
  in with "You're already in this league" (don't consume a use, don't error). Add a
  test asserting a second accept by the same user is a no-op.
- **Owner controls**: revoke/regenerate, set max-uses + expiry, see who has joined
  — in the reworked Invite section.

---

## 7. Milestones (each shippable; bug fixes first)

- **F0 — Unbreak prod (must ship first).**
  - §2.1 read-model fantasy slices + `score-db.ts` reads from read-model in prod
    (draft room + recompute work). §2.2 gate + configure push (VAPID). §2.3 sweep.
  - **Accept:** draft room 200 in prod; a full draft can run; push toggle only
    shows when usable; recompute runs in-container.
- **F1 — UX foundations + the cross-cutting decisions.** Design language
  (icons/cards/badges/motion), the per-league **tab nav**, skeletons + friendly
  errors, the glossary/`<Explain>` primitive + help surface + `<StatusNarration>`,
  **accessibility** + **observability** baselines (§3.7/§3.8), the fantasy error
  boundary, and **resolve the privacy model (Q7)** — it gates the dashboard
  redesign. (§3, §4.9)
  - **Accept:** tab nav + skeletons + status narration render across states;
    a11y keyboard pass; a fantasy 500 now shows in logs + a friendly boundary;
    privacy model decided.
- **F2 — Index + dashboard + create.** Informative landing, league cards, the
  dashboard hub with header + checklist + organized sections, **inline league
  rename** (owner; `LeagueService.rename`, slug stays stable), and **member
  leave / owner cancel** (§4.9). (§4.1–4.3)
- **F3 — League image + `<PhotoUpload>`.** Schema + service + the shared uploader;
  wire into create/settings/corps-identity; show on cards/header/join. (§5)
- **F4 — Invite rework.** Auto-link + share + explain + join-once UX. (§6)
- **F5 — Quiz + Draft + Standings polish.** Explainers, progress, legends, mobile
  reworks, draft pool sort/filter, auto-pick warning, standings highlights. (§4.4–4.6)
- **F6 — Quiz-admin polish.** (§4.8)

> F0 is non-negotiable and independent — ship it first. F1 makes the
> cross-cutting decisions (privacy) and primitives that F2–F6 reuse. Commit per
> surface (AGENTS.md). Everything stays behind `VITE_ENABLE_FANTASY`; **verify on
> dev (incl. a real draft, on a phone) before prod** — the §10 live-E2E discipline
> is now mandatory (§2.3), not optional.

---

## 8. Testing & verification

UI work is the easiest to ship broken (the draft 500 proves it). Gate each
milestone:
- **Keep the backend integration tests green** (the services already have them);
  add tests for the new backend bits: `LeagueService.rename` (slug stable),
  `MembershipService.leave` (self-only), invite `getOrCreateShareLink` (reuses a
  valid link; second accept by the same user is a no-op), and the read-model
  fantasy readers (§2.1) — point a test at the emitted `rm_fantasy_*` and assert
  parity with the relational source.
- **Pure-selector tests** for `describeLeagueState` (the status narration) and the
  status-badge map across every league/draft state.
- **Component/interaction tests** (vite-plus/test + Testing Library) for the
  `<PhotoUpload>` (validation/preview/error), the tab nav (keyboard), inline
  rename, and the invite share/copy.
- **Accessibility checks**: keyboard pass + an axe-style audit on each fantasy
  route; verify `prefers-reduced-motion` and dark-mode contrast.
- **Live E2E on dev before prod** (the §2.3 rule) — the full flow including a real
  draft, on a phone for the mobile reworks.
- **Prod data-source healthcheck** (§2.3/§3.8) wired into the deploy.
- **Bundle guard**: confirm the client chunk stays Effect-free after adding the
  uploader/rename server-fns (the `createServerFn` split handles this — verify in
  the deployed container per the no-local-builds memory).

## 9. Risks & mitigations
- **R1 — Read-model emit scope/cadence (§2.1).** The fantasy slices must refresh
  with each scrape; a stale `rm_fantasy_season_best` makes standings look frozen.
  *Mitigate:* emit them in the same `emitReadModel.ts` pass; verify freshness in
  the healthcheck.
- **R2 — Enabling on prod without dev E2E** (how the draft 500 shipped).
  *Mitigate:* the §2.3 mandatory dev-E2E rule + healthcheck before flag flips.
- **R3 — Scope creep.** This plan is large; F0 is the only urgent part. *Mitigate:*
  ship F0 first and independently; treat F1–F6 as incremental, each shippable.
- **R4 — Optimistic UI desync.** Inline rename / identity / picks via optimistic
  collection updates can diverge from the server. *Mitigate:* reconcile from the
  authoritative refetch/SSE; key by id; roll back on error.
- **R5 — `<PhotoUpload>` convergence.** Replacing contrib's `ImageDrop` risks
  regressing the wiki upload. *Mitigate:* build the new component for fantasy
  first; migrate contrib later behind its own verification (Q3).
- **R6 — Privacy decision (§4.9).** Shipping nav/preview polish before deciding the
  spectator/privacy model could leak private rosters. *Mitigate:* resolve Q (privacy)
  in F1, before the dashboard/standings redesign goes to prod.
- **R7 — Mobile draft realtime.** SSE + sticky clock + tabs on mobile is the
  hardest interaction and unverifiable without a device. *Mitigate:* real-device
  test; reconnection indicator; keep the legacy layout behind a fallback until
  verified.

## 10. Component & backend inventory (concrete deliverables)
**New shared components:** `<PhotoUpload>`, `<StatusNarration>` (+
`describeLeagueState` selector), `<Explain term>` (+ glossary map),
`<LeagueTabs>` (per-league nav), `<StatusBadge>` (+ `STATUS_BADGE` map),
`<GettingStartedChecklist>`, `<LeagueCard>`, `<StandingsCardList>` (mobile),
`<ShareButton>` (navigator.share + copy fallback), a fantasy route error boundary,
skeletons per read page.
**New/changed backend:** read-model fantasy readers + `rm_fantasy_*` emit (§2.1);
`LeagueService.rename` + `renameLeague` shim; `MembershipService.leave` +
shim; owner cancel/transfer; `InviteService.getOrCreateShareLink`;
`MediaService` generalized for league images + `fantasy_leagues.logo_media_id`
(+ optional cover) via `ensureColumns`; push gating (`getVapidPublicKey`-null);
`describeLeagueState` (pure, shared client+server).
**Config/ops:** VAPID keys in prod; fantasy healthcheck; dev-E2E runbook step.

## 11. Open questions
- **Q1 — Read-model size/cadence.** The fantasy slices (draft pool, prior-finals,
  season-best, finals) must refresh with each scrape/emit. Confirm they're small
  enough to ride the existing read-model push and that `season-best` updates often
  enough for "live" standings.
- **Q2 — League image shape.** Square avatar only, or avatar + wide cover banner?
  (Affects schema columns + the cropper aspect.)
- **Q3 — One uploader or two.** Converge contrib's `ImageDrop` onto the new
  `<PhotoUpload>` now, or leave contrib alone and only use the new one for fantasy?
- **Q4 — Payments visibility.** Payments are env-gated (off in prod now). Keep the
  billing UI conditional; don't show it when `FANTASY_PAYMENTS_ENABLED` is off.
- **Q5 — Auto-link privacy.** Auto-generating an invite link on view means a link
  always exists; confirm that's desired vs. an explicit "create link" for owners
  who want control over when a shareable link exists.
- **Q6 — Draft engine flag.** This UX work targets whichever engine is active; when
  `FANTASY_EFFECT_DRAFT` flips on (migration plan), re-verify the draft room UI
  against the Effect `DraftService` + its PubSub SSE.
- **Q7 — Privacy model (§4.9).** Is a league private (members-only dashboard +
  tokened spectator link) or a public read-only spectator view? `getLeague` is
  currently ungated. Decide before the dashboard/standings redesign ships (R6).
- **Q8 — Leave/cancel semantics.** Can a member leave after the draft (rosters
  lock)? Does leaving forfeit their standings row? Owner cancel vs transfer — what
  happens to a paid league's refund? (§4.9, ties to payments.)
- **Q9 — Status narration source.** `describeLeagueState` needs draft timing +
  quiz-taken counts; confirm `getLeague`'s payload carries enough (draft
  scheduled_at, per-member quiz_taken) or extend it.
