# Fantasy DCI — Implementation Plan

Status: **DRAFT for review** · Owner: TBD · Created: 2026-06-17

A season-long fantasy game where users form private leagues, draft per-caption
"scores" from real drum corps, and earn standings computed from real recap data
after every show. This document is the authoritative design + build plan.

---

## 0. TL;DR

- Users create **leagues** (invite-only), invite friends via **links**, run an
  optional **knowledge quiz** that sets **draft order**, hold a **scheduled,
  real-time draft**, and accrue standings where each pick scores its corps'
  **season-best caption score** (§5.2), recomputed after each scrape using DCI
  scoring math (with **configurable category weights**, editable until finals).
- Built on existing infra: `better-auth` (Google + magic link), raw
  `@libsql/client` SQL on the durable `contributions.db`, Resend for email, R2
  for images, and an **SSE** live channel for the draft (no WebSocket server,
  no `proxy.mjs` changes).
- Payments (paid league creation) and push notifications are **later phases**
  with schema hooks reserved now.

---

## 0.5 How to use this document (read first)

This plan has two parts. **Part I (§1–§18)** is the design and rationale.
**Part II (Appendices A–I, at the end)** is the literal execution reference:
copy-pasteable SQL, exact value mappings, algorithms with worked numbers,
server-function contracts, and code skeletons. **When building, follow Part II
exactly.** Where Part I and Part II ever disagree, **Part II wins** (it is the
precise version).

**Non-negotiable conventions for the executor — apply these everywhere, do not
deviate:**

1. **IDs:** every new row's primary id is `crypto.randomUUID()` (a string). Never
   auto-increment.
2. **Timestamps:** every timestamp column is an ISO-8601 UTC string,
   `new Date().toISOString()`. Store as TEXT.
3. **Database handles:** the writable DB (all `fantasy_*` tables + better-auth
   tables) is `contributions.db`, obtained with `await getContributionsDb()`
   from `@/lib/contributions-db`. The read-only score DB is `dci-relational.db`;
   open it with its own client (Appendix C.5). **Never** write to
   `dci-relational.db`.
4. **Queries:** always `await db.execute({ sql: '...', args: [...] })` with
   bound `?` parameters. **Never** string-concatenate user input into SQL. Read
   results from the returned `.rows` array. For multiple writes that must be
   atomic, use `db.batch([...], 'write')`.
5. **Migrations:** add new tables by appending their `CREATE TABLE IF NOT EXISTS`
   / `CREATE INDEX IF NOT EXISTS` strings to the existing `SCHEMA` array in
   `app/lib/contributions-db.ts` (Appendix B). The existing
   `db.batch(SCHEMA, 'write')` runs them once per process. Statements must be
   idempotent (`IF NOT EXISTS`). Do not write a separate migration runner.
6. **Validation (never trust the client):** every server function re-validates
   its input server-side with valibot before doing anything. Defining the
   valibot schema is part of writing the function. JSON config columns are
   parsed/validated on read and write.
7. **Authorization:** every write server function calls `getActor(getWebRequest())`
   (from `@/lib/authz`) and checks membership/ownership **before** mutating.
   Throw on failure. UI checks are cosmetic; the server is the gate.
8. **Server functions:** follow the exact `createServerFn` pattern in Appendix
   F.0 (copied verbatim from `app/lib/server-fns/contrib.ts`). Put all fantasy
   server functions in `app/lib/server-fns/fantasy.ts` unless noted.
9. **Feature flag:** all fantasy routes and nav entries are gated behind
   `import.meta.env.VITE_ENABLE_FANTASY === 'true'`. When off, the routes 404.
10. **Caption keys:** the 8 caption keys are exactly
    `['GE1','GE2','VP','VA','CG','MB','MA','MP']`. The score DB stores different
    strings (e.g. `"Music - Brass"`); use the mapping in Appendix C.1 — never
    invent the strings.
11. **If something is ambiguous,** stop and re-read Part II; if still ambiguous,
    leave a `// TODO(plan-gap): <question>` comment and pick the simplest
    behavior that passes the milestone's acceptance check — do not invent
    elaborate behavior.

---

## 1. Goals & Non-Goals

### Goals
1. Private, invite-only fantasy leagues with a clear owner/admin.
2. Frictionless join flow that survives the Google OAuth redirect round-trip.
3. Admin-curated knowledge quiz that influences draft order, with a
   configurable "high-knowledge-first vs. low-knowledge-first" toggle.
4. Scheduled, real-time, fair draft (snake or linear) with a server-side
   auto-picker for absent/slow drafters.
5. Standings recomputed automatically after each show scrape, using DCI math
   with an admin-configurable GE weight; final standings lock at season end.
6. Notifications (email now, push later) for the moments that matter: invite,
   draft scheduled, draft starting soon, your pick is on the clock, you were
   auto-picked, standings updated, season complete.

### Non-Goals (v1)
- Public/discoverable leagues (invite-only only).
- Trades, waivers, in-season roster edits (rosters lock after the draft).
- Mobile app / native push (web push is a later phase).
- Multi-season history/portability beyond the current season.
- Real-money prizes or payouts (only *paying to create* a league, later).

---

## 2. Assumptions (confirm before build)

- **A1** Groups are **invite-only**. No public browsing/joining in v1.
- **A2** **Any signed-in user** can create a league and becomes its **league
  owner** (distinct from site `admin` role).
- **A3** The **quiz question bank is curated by site admins/moderators** using
  the existing `authz` role system. League owners cannot author questions in v1.
- **A4** Quiz affects **draft order only** (not in-draft point weighting).
- **A5** Each pick scores the corps' **season-best caption score to date**
  (§5.2), recomputed after each scrape; final standings lock when the season's
  championship recap lands. Owner can adjust scoring weights until finals week.
- **A6** One **caption per corps** per roster by default; rosters lock after the
  draft (no in-season changes).
- **A7** Payments are deferred; v1 leagues are free. Refund policy below is
  designed but not implemented until the payment phase.
- **A8** Single Node process serves the app (the SSE in-memory bus and
  auto-pick timers assume one process; see §11 Variance for multi-instance).
- **A9** Quiz is **one scored attempt per member per league** (no retake),
  questions drawn from the bank by a difficulty mix, with a join/quiz deadline
  before the draft. Members who miss it sort last in draft order (§6).
- **A10** Draftable pool = **active World + Open corps for the season** from the
  corps directory; **one draft per league per season**; rosters must be fully
  filled (auto-pick completes any unfilled slots at draft end).
- **A11** Draft is **pre-season** (`draftPhase='preseason'`); auto-pick and the
  suggested-pick hint rank by **prior-season finals** caption scores.

---

## 3. Existing Infrastructure We Reuse (verified)

| Concern | What exists | Path |
|---|---|---|
| Auth | `better-auth` v1.6.19 — Google OAuth, magic link, passkey | `app/lib/auth.ts`, `app/lib/auth-client.ts`, `app/routes/api/auth/$.ts` |
| Roles/caps | `Role` (`user→trusted→moderator→admin`), `can()`, `requireCapability()`, `getActor()` | `app/lib/authz.ts` |
| Writable DB | raw `@libsql/client` (`createClient`), in-code `CREATE TABLE IF NOT EXISTS` migrations, WAL+busy_timeout | `app/lib/contributions-db.ts` |
| Score DB | `dci-relational.db` — `corps_scores`, `category_scores`, `caption_scores`, `judge_scores` | `docs/dci_domain.md`, `sdk/src/relational.ts` |
| Scrape pipeline | `scrapeWebsiteRecapsForSeason()` → `ingestWebsiteRecap()` | `sdk/src/websiteScraper.ts` (~L438–518), `sdk/src/relational.ts` (L5738+) |
| Server fns | `createServerFn({method}).validator().handler()` + Effect Schema/valibot validation | `app/lib/server-fns/*.ts` |
| Email | Resend via `sendMagicLink` pattern; env `RESEND_API_KEY`, `MAGIC_LINK_FROM` | `app/lib/auth.ts` (L34–50) |
| Image upload | `uploadShowMedia` → sharp→WebP→R2 `putUpload`, served via `/api/show-media/$id` | `app/lib/server-fns/media.ts`, `app/lib/r2.ts` |
| SSE | Fate live channel pattern (`text/event-stream`, in-memory bus, lastEventId resume) — forwarded fine by `proxy.mjs` | `app/fate/server.ts`, `app/fate/client.ts`, `proxy.mjs` |
| Service worker | Registered SW for offline caching (no push yet) | `public/sw.js`, `app/lib/register-sw.ts` |
| Scoring constants | 8 captions `GE1,GE2,VP,VA,CG,MB,MA,MP`; families GE/Visual/Music; `divisionCategory()` | `app/lib/prediction-scenario.ts`, `app/lib/caption-family.ts` |

**Gaps to build:** groups/invites/quiz/draft/standings tables; an SSE route for
the draft; a generic transactional-email helper; (later) web-push and payments.

---

## 4. Data Model

All new tables live in `contributions.db` (durable `/data` volume in prod),
created via the existing `CREATE TABLE IF NOT EXISTS` migration block in
`contributions-db.ts`. All ids are UUID v4 strings (`crypto.randomUUID()`),
all timestamps ISO-8601 UTC strings, matching existing conventions.

> Convention note: existing tables use `*_id` text PKs and store structured
> blobs as JSON text columns. We follow that. JSON config columns are validated
> with valibot on every write (never trust client; re-parse server-side).

### 4.1 `fantasy_leagues`
| col | type | notes |
|---|---|---|
| `league_id` | TEXT PK | uuid |
| `slug` | TEXT UNIQUE | url-safe, generated from name + short suffix |
| `name` | TEXT | display |
| `owner_user_id` | TEXT | FK→`user.id`; the league admin |
| `season` | TEXT | e.g. `2026` |
| `status` | TEXT | `setup`→`quiz`→`scheduled`→`drafting`→`active`→`complete`→`canceled` |
| `config_json` | TEXT | validated `LeagueConfig` (see §6) |
| `max_members` | INTEGER | default 12 |
| `created_at` / `updated_at` | TEXT | |
| `payment_status` | TEXT | `none`/`paid`/`refunded` (reserved; default `none`) |
| `payment_ref` | TEXT NULL | provider session/charge id (reserved) |

Indexes: `(owner_user_id)`, `(slug)`, `(season, status)`.

### 4.2 `fantasy_members`
| col | type | notes |
|---|---|---|
| `league_id` + `user_id` | TEXT, TEXT | composite PK |
| `role` | TEXT | `owner`/`member` (co-admins later) |
| `corps_name` | TEXT NULL | fantasy corps name (set during join) |
| `show_title` | TEXT NULL | the corps' "show" / production title |
| `corps_logo_media_id` | TEXT NULL | FK→media; their corps logo (uploaded) |
| `corps_color` | TEXT NULL | hex accent color |
| `quiz_score` | REAL NULL | weighted quiz score (null until taken) |
| `draft_position` | INTEGER NULL | resolved before draft |
| `status` | TEXT | `active`/`removed` |
| `joined_at` | TEXT | |

Index: `(user_id)` so a user can list their leagues.

### 4.3 `fantasy_invites`
| col | type | notes |
|---|---|---|
| `invite_id` | TEXT PK | |
| `league_id` | TEXT | FK |
| `token` | TEXT UNIQUE | high-entropy (32 bytes base64url); **the link secret** |
| `created_by` | TEXT | user id |
| `email` | TEXT NULL | if set, link is "bound" to this email (soft) |
| `max_uses` | INTEGER | default 1; owner can mint a shareable multi-use link |
| `used_count` | INTEGER | default 0 |
| `expires_at` | TEXT | default +14 days |
| `revoked_at` | TEXT NULL | |
| `created_at` | TEXT | |

Index: `(league_id)`, unique `(token)`.

### 4.4 `fantasy_quiz_questions` (admin-curated bank, league-agnostic)
| col | type | notes |
|---|---|---|
| `question_id` | TEXT PK | |
| `prompt` | TEXT | |
| `choices_json` | TEXT | array of strings (2–6) |
| `correct_index` | INTEGER | |
| `explanation` | TEXT NULL | shown after answering |
| `difficulty` | TEXT | `easy`/`medium`/`hard` (weights 1/2/3) |
| `tags_json` | TEXT | e.g. `["history","2024","percussion"]` |
| `active` | INTEGER | soft delete (0/1) |
| `author_user_id` | TEXT | |
| `created_at` / `updated_at` | TEXT | |

> We never delete questions that have attempts referencing them; we set
> `active=0`. Correct answers are **never sent to the client** until the
> attempt is scored server-side.

### 4.5 `fantasy_quiz_attempts`
| col | type | notes |
|---|---|---|
| `attempt_id` | TEXT PK | |
| `league_id` + `user_id` | TEXT, TEXT | one *scored* attempt per (league,user) |
| `question_ids_json` | TEXT | the served set + order (frozen at start) |
| `answers_json` | TEXT | index per question |
| `raw_score` | REAL | sum of correct difficulty weights |
| `max_score` | REAL | sum of served difficulty weights |
| `weighted_score` | REAL | normalized 0–1 (`raw/max`) — used for ordering |
| `started_at` / `completed_at` | TEXT | timer enforcement server-side |

Unique: `(league_id, user_id)` where `completed_at IS NOT NULL`.

### 4.6 `fantasy_drafts`
| col | type | notes |
|---|---|---|
| `draft_id` | TEXT PK | |
| `league_id` | TEXT UNIQUE | one draft per league (v1) |
| `status` | TEXT | `scheduled`/`live`/`paused`/`complete` |
| `scheduled_at` | TEXT | start time set by owner |
| `order_json` | TEXT | resolved array of user_ids (base order) |
| `draft_type` | TEXT | `snake`/`linear` (mirrors config at lock time) |
| `pick_seconds` | INTEGER | per-pick clock (e.g. 60) |
| `total_rounds` | INTEGER | = roster slots per member |
| `current_pick_no` | INTEGER | 0-based global pick counter |
| `current_user_id` | TEXT NULL | whose turn |
| `pick_deadline_at` | TEXT NULL | drives auto-pick timer |
| `started_at` / `completed_at` | TEXT NULL | |

### 4.7 `fantasy_picks`
| col | type | notes |
|---|---|---|
| `pick_id` | TEXT PK | |
| `league_id` + `user_id` | TEXT, TEXT | |
| `corps_key` | TEXT | FK→corps (relational db key) |
| `caption` | TEXT | one of the 8 caption keys |
| `round` | INTEGER | 1-based draft round = this member's pick ordinal; **drives reverse-weighting** (§6) |
| `pick_no` | INTEGER | global pick order across all members |
| `caption_slot_index` | INTEGER | 1-based index within its caption for this member; used ONLY to enforce caption caps |
| `weight` | REAL | scoring multiplier from the round-based ramp (default 1.0→2.0 over rounds; see §6) |
| `auto_picked` | INTEGER | 0/1 |
| `created_at` | TEXT | |

Uniqueness / integrity (enforced by unique indexes + server validation):
- **U1** A `(corps_key, caption)` can be drafted by **at most one** member in a
  league (no two people own "BD brass"). → unique `(league_id, corps_key, caption)`.
- **U2** One **caption per corps** per member (no stacking BD across captions). →
  unique `(league_id, user_id, corps_key)` (toggleable via config; see §6).
- **U3** Caption-category caps (e.g. ≤5 brass picks) enforced in app logic.

### 4.8 `fantasy_standings` (recomputed snapshot)
| col | type | notes |
|---|---|---|
| `league_id` + `user_id` | TEXT, TEXT | |
| `through_competition_slug` | TEXT | last recap included |
| `total_score` | REAL | season-best-derived fantasy total (see §5) |
| `ge_score` / `visual_score` / `music_score` | REAL | category subtotals |
| `breakdown_json` | TEXT | per-pick contributions for the UI |
| `rank` | INTEGER | within league |
| `computed_at` | TEXT | |
| `is_final` | INTEGER | set when season locks |

### 4.9 `fantasy_notifications` (in-app inbox + delivery log)
| col | type | notes |
|---|---|---|
| `notif_id` | TEXT PK | |
| `user_id` | TEXT | |
| `league_id` | TEXT NULL | |
| `kind` | TEXT | `invite`/`draft_scheduled`/`draft_soon`/`on_the_clock`/`auto_picked`/`standings`/`season_complete` |
| `payload_json` | TEXT | |
| `read_at` | TEXT NULL | |
| `email_sent_at` / `push_sent_at` | TEXT NULL | delivery dedupe |
| `created_at` | TEXT | |

### 4.10 `fantasy_push_subscriptions` (reserved for push phase)
`endpoint`, `p256dh`, `auth`, `user_id`, `created_at` — Web Push subscription
keys. Empty until the push phase.

### 4.11 Migration & isolation considerations
- Add all tables to the existing migration array in `contributions-db.ts`; they
  are additive and safe on existing prod data.
- **Durability invariant (I-7):** these tables MUST be on `/data`. The write
  server-fns must `requireDurableStorage()` (reuse `durableStorageStatus`) and
  fail closed if the volume is missing — otherwise a deploy wipes leagues.
- **Backups:** confirm the `restic`/R2 backup job covers `contributions.db`
  (it should, since wiki data already lives there). Add a check to the runbook.

---

## 5. Scoring Engine (the heart)

### 5.1 Source data
Read from `dci-relational.db` (`caption_scores`, `category_scores`,
`corps_scores`) keyed by `competition_slug` + `corps_key`. Caption scores are
already judge-averaged on the sheet (`caption_scores.score`).

### 5.2 Per-pick value = the corps' SEASON-BEST caption score (to date)

This is the core resolution rule (confirmed): a pick's contribution is **the
highest score that corps has earned in that caption so far this season** — not
a per-show sum. As the season progresses a corps' best can only rise, so
standings monotonically improve and stabilize at finals.

For each **pick** `(corps_key, caption)`:

1. Query `caption_scores` for that `(corps_key, caption)` across all scored
   World/Open competitions in the season **up to the latest scrape**, and take
   the **MAX `score`**. (Only that corps' own best in that one caption matters.)
2. If the corps has not yet scored in that caption this season → contributes
   **0** until it does.

`captionSeasonBest(corps_key, caption, asOf) = MAX(score)` is a single SQL
aggregate; the whole lookup table for a league is one grouped query.

### 5.3 Roster total — WEIGHTED AVERAGE per caption → real recap scale (≤ 100)

**Goal (confirmed):** the roster total must look like a real DCI recap — each
caption on its natural 0–20 basis, categories via the real DCI formula, **total
≤ 100**. The reverse-weighting (§6) must still bias toward "save the best for
last," but it must **not** inflate the score past a real recap.

**The bounding rule — divide by the SUM OF WEIGHTS, not by the count.** For a
caption `c` with picks `i = 1..N`, each with season-best `vᵢ` (§5.2, 0–20 scale)
and round-weight `wᵢ` (§6):

```
cap[c] = Σ(vᵢ · wᵢ) / Σ(wᵢ)          // a weighted average
```

A weighted average of values that are each ≤ 20 is itself **always ≤ 20**,
regardless of how lopsided the weights are. That is the whole trick: the caption
stays on a 0–20 scale, so the recap total stays ≤ 100. (If `N = 1`, this reduces
to just `v₁`. If `Σ(wᵢ) = 0`, treat as missing → 0.)

The weighting still matters because a weighted average is **pulled toward the
higher-weighted pick**: placing your best corps on your highest-weight (latest)
round pulls the caption average up toward it; wasting a high weight on a weak
corps drags it down. (Worked numbers: Appendix D.)

Full pipeline (`scoringMode`, owner-set, **default `recap`**):
1. **`recap` (default).** Per caption: weighted average as above. Then real DCI
   category math:
   - `geRaw = cap.GE1 + cap.GE2`            (each ≤ 20 → ≤ 40)
   - `visualRaw = (cap.VP + cap.VA + cap.CG) / 2`   (≤ 30)
   - `musicRaw = (cap.MB + cap.MA + cap.MP) / 2`    (≤ 30)
   Then apply category `weights` (below). Total ≤ 100. **This is what renders in
   the recap-style UI.**
2. **`sum` (optional, off by default).** `Σ(vᵢ · wᵢ)` with NO normalization —
   a raw points pile that can exceed 100. Only for owners who explicitly want
   accumulation rather than a recap look. The UI must NOT dress this as a 0–100
   score.

**Category `weights`** (default GE 40 / Visual 30 / Music 30, owner-set, editable
until finals week — §16 V3): apply as `ge = geRaw · weights.ge/40`,
`visual = visualRaw · weights.visual/30`, `music = musicRaw · weights.music/30`.
**Validate/normalize `weights` so they sum to 100** — then the maximum possible
total is exactly 100 for any weighting (a perfect 20-everywhere roster = 100; a
realistic ~19 roster ≈ 95, just like a real recap). `missingCaptionPolicy`
covers an unfilled caption (`'zero'` in v1).

> Centralized in pure functions `captionSeasonBest()` and
> `computeRosterScore(picks, seasonBestLookup, weights, scoringMode)` so each
> mode is independently unit-testable against `docs/dci_domain.md` arithmetic.

### 5.4 Standings
- Standings are a pure function of (picks, season-best lookup, current weights):
  fully recomputable from scratch on every scrape → **idempotent**, no drift.
- Because value = season-best, a corrected/late recap simply updates the max on
  the next recompute. Locked `is_final` at finals.

### 5.5 When it runs (hook point)
- Primary hook: after `scrapeWebsiteRecapsForSeason()` finishes ingesting a
  season's recaps (`sdk/src/websiteScraper.ts` ~L507), call
  `recomputeFantasyStandingsForSeason(season)`.
- This routine: lists active leagues for `season` → for each, recompute all
  members' standings → write `fantasy_standings` → enqueue `standings`
  notifications (throttled; see §8) → if the season's **finals competition date
  has passed** and its recap is present, set `is_final=1`, lock weights, set
  league `status='complete'`, and emit `season_complete`.
- **Finals detection (confirmed):** read the World Championship Finals
  competition's `date` for the season directly from `dci-relational.db`
  (`competitions` table — the 2026 finals row already exists). "Finals week" =
  on/after that date; weights lock and standings finalize once its recap lands.
- The recompute reads `dci-relational.db` and writes `contributions.db`; it
  runs in the same Node/SDK context the scraper already uses.

### 5.6 Determinism & testing
- `captionSeasonBest` and `computeRosterScore` are **pure functions** over plain
  inputs → golden-file unit tests using a frozen 2024 recap fixture.
- Property test: a roster of the literal top corps per caption should reproduce
  (within rounding) the real champion's category math when weights = DCI default
  and each pick's season-best is that corps' best showing.

---

## 6. Configurability (`LeagueConfig`, validated with valibot)

Stored in `fantasy_leagues.config_json`; surfaced in the league setup UI.
Draft-shape settings (draft type, roster slots, caption caps, divisions,
reverse-weighting) **freeze at draft start**. **Scoring `weights` remain
editable by the owner until finals week** (§16 V3) and every recompute uses the
current weights.

```ts
type LeagueConfig = {
  // Draft
  draftType: 'snake' | 'linear';
  pickSeconds: number;            // per-pick clock; default 60
  quizOrderDir: 'high_first' | 'low_first' | 'random' | 'manual';
  // Roster = per-caption slot counts over the FULL 8 captions (GE1 & GE2 stay
  // separate, confirmed). rosterSlots is derived = sum(captionCaps).
  captionCaps: Record<CaptionKey, number>;  // e.g. { GE1:2, GE2:2, VP:3, ..., MP:5 }; default 2 each
  oneCaptionPerCorps: boolean;    // U2; default true
  allowedDivisions: ('world'|'open')[]; // fixed to World + Open (no All-Age / SoundSport)

  // Reverse weighting — the core "save the best for last" mechanic (§6).
  // Weight is driven by your OVERALL pick ROUND (1..total_rounds), NOT by
  // caption: your 1st overall pick is weighted lowest, your last pick highest.
  // Linear ramp from minWeight (round 1) to maxWeight (last round). This makes
  // it optimal to spend early, low-weight rounds on lower corps and hold late,
  // high-weight rounds for elites — which rivals can snipe early (§6).
  reverseWeighting: {
    enabled: boolean;             // default TRUE (core mechanic)
    minWeight: number;            // round-1 multiplier; default 1.0
    maxWeight: number;            // last-round multiplier; default 2.0 (>= minWeight)
  };

  // Scoring (each pick contributes the corps' season-best in that caption, §5.2)
  scoringMode: 'recap' | 'sum';   // default 'recap' = weighted-avg per caption → DCI math, total <= 100 (§5.3)
  weights: { ge: number; visual: number; music: number }; // default 40/30/30; MUST sum to 100
  weightsLockedAt: 'never' | 'finals_week';  // default 'finals_week' — editable until then (§16 V3)
  missingCaptionPolicy: 'zero' | 'prorate';               // default zero

  // Draft timing / ranking
  draftPhase: 'preseason';        // v1: pre-season draft (confirmed)
  rankingSource: 'prior_season';  // auto-pick & suggested order rank by prior-season finals (confirmed)

  // Notifications
  notify: { email: boolean; push: boolean };              // default email:true

  // Quiz
  quiz: { enabled: boolean; questionCount: number; perQuestionSeconds: number };
};
```

**Quiz → draft order resolution** (`quizOrderDir`):
- `high_first`: highest `weighted_score` picks first.
- `low_first`: lowest first (the "underdog boost" dynamic).
- `random`: seeded shuffle (seed stored for reproducibility; remember
  `Math.random()` is unavailable in workflow scripts but this runs in normal
  server context where it's fine).
- `manual`: owner drags to order.
- Ties broken by `completed_at` (earlier finisher wins), then by user_id hash.
- Members who never take the quiz are placed **last** (or randomized among
  themselves), surfaced clearly in the UI.

**Reverse weighting** (confirmed core mechanic — *save the best for last,
across your whole roster*): a pick's multiplier is set by **your overall pick
round**, not by caption. It ramps linearly from `minWeight` (your 1st overall
pick) to `maxWeight` (your last overall pick) — default **1.0 → 2.0**. Formula
for round `r` of `R` total rounds: `weight = minWeight + (maxWeight - minWeight)
* (r - 1) / (R - 1)` (and `weight = minWeight` if `R == 1`).

**Why this is fun (the game theory):** because late rounds multiply harder, the
optimal play is to spend your **early, low-weight rounds on deliberately lower
(but still solid) corps** and **hold your late, high-weight rounds for the
elites** — a top corps only "pays off" in a high-weight slot. But every
`(corps, caption)` is unique in a league (U1), so a rival can **snipe** the
elite you're saving by taking it in one of *their* earlier, lower-weight rounds
(accepting the smaller multiplier to deny it to you). So you're constantly
trading off "wait for the bigger multiplier" against "grab it before someone
else does." It actively rewards drafting lower-scoring corps early.

We use a **linear ramp, not exponential**: over ~14 rounds an exponential
`factor^(r-1)` explodes (1.25¹³ ≈ 18×), making early picks worthless; the
1.0→2.0 ramp keeps the incentive real but bounded (your last pick ≈ 2× your
first). On by **default**; owner can disable or tune `min/maxWeight`. The draft
UI shows each round's live multiplier so the trade-off is legible.
(The multiplier is applied to each pick's season-best value in §5.3 step 1;
weight is stored per pick in `fantasy_picks.weight`. `caption_slot_index` is
retained only for enforcing caption caps, not for weighting.)

---

## 7. Join / Invitation Flow (highest-risk UX)

### 7.1 Owner mints an invite
- Server-fn `createInvite(leagueId, {email?, maxUses?, expiresInDays?})`
  → requires `actor.userId === league.owner_user_id`.
- Returns link: `https://drumcorps.app/fantasy/join/<token>`.
- If `email` set: also send an invite email (Resend) with the link.

### 7.2 Invitee clicks the link (the redirect gauntlet)
Route `app/routes/fantasy/join/$token.tsx`:

1. **Loader** validates token (exists, not revoked, not expired,
   `used_count < max_uses`). Shows league name, owner, member count, and a
   "Join this league" CTA. Invalid → friendly error page with reasons.
2. **If already signed in** (`getActor`): show the "choose corps name + picture"
   step immediately, then `acceptInvite`.
3. **If signed out:** clicking "Continue with Google" must **preserve the
   token across the OAuth round-trip**. Mechanism:
   - Before redirecting to `better-auth` Google sign-in, set a **short-lived,
     httpOnly, SameSite=Lax cookie** `fantasy_invite=<token>` (also pass
     `callbackURL=/fantasy/join/<token>` to better-auth so we land back on the
     same route).
   - better-auth handles Google → callback → session established → redirects to
     `callbackURL`.
   - Back on `/fantasy/join/$token`, the loader now sees a session; we read the
     cookie as a fallback if the path token was lost; proceed to accept.
   - **Edge:** SameSite=Lax allows the cookie on top-level GET redirect back
     from Google (top-level navigation) — verified-appropriate; we set it
     server-side via the route, not better-auth internals.
4. **Magic-link alternative:** if the user prefers email, we send a magic link
   whose `callbackURL` is `/fantasy/join/<token>`; same landing behavior.

### 7.3 `acceptInvite` (server-fn, transactional)
- Re-validate token (race-safe: `UPDATE ... SET used_count=used_count+1 WHERE
  token=? AND used_count<max_uses AND revoked_at IS NULL AND expires_at>now`
  and check `rowsAffected`).
- Guards: league `status` must allow joining (`setup`/`quiz`/`scheduled`),
  `members < max_members`, user not already a member.
- Insert `fantasy_members` row (`role='member'`).
- Return the league + a flag to prompt corps identity if unset.

### 7.4 Corps identity step
Participants brand their fantasy corps with four fields:
- **Corps name** — `corps_name`, validated, deduped within the league, optional
  profanity filter.
- **Show title** — `show_title`, free text (the corps' "production" name).
- **Logo** — uploaded image via the **existing** `uploadShowMedia` path
  (sharp→WebP→R2, strips EXIF), stored as `corps_logo_media_id` and served from
  `/api/show-media/$id`.
- **Color** — `corps_color` hex accent via the existing color tooling; used to
  theme the corps across the draft board, roster, and leaderboard.

Editable from the league dashboard until the draft starts (then locked for
roster/leaderboard consistency; name/logo/show/color tweaks could stay editable
later — minor, decide in build). `setCorpsIdentity` server-fn validates and
persists all four; identity is required before a member can be marked draft-ready.

### 7.5 Invite edge cases (must handle)
- Token reused beyond `max_uses` → clear "this invite is used up" + ask owner.
- Expired/revoked token.
- League full → waitlist? v1: reject with message; owner can bump `max_members`.
- Already a member (re-click) → no-op, route to league dashboard.
- Joining after draft started → blocked; show "draft already in progress."
- Signed in as a **different account** than an email-bound invite → allow but
  warn (email binding is soft in v1).
- League canceled/refunded → invite dead; explain.
- User deletes account mid-season → mark member `removed`; their picks remain
  for scoring integrity but drop from leaderboard (configurable).

---

## 8. Notifications

### 8.1 Email (v1, reuse Resend)
- Refactor the inline `sendMagicLink` into a generic
  `app/lib/email.ts → sendEmail({to, subject, html, tag})` (keeps the
  RESEND_API_KEY guard + dev console fallback). Add minimal HTML templates.
- Triggered emails: invite, draft scheduled, **draft starts in 1 hour / 10
  min** (scheduled reminder), your-pick-on-the-clock (optional; can be noisy),
  auto-picked summary, weekly standings digest, season complete.
- **Throttling/dedupe:** `fantasy_notifications.email_sent_at` prevents double
  sends; standings emails are **digested** (one per scrape batch, not per
  pick). Respect `config.notify.email` and a per-user global opt-out.
- **Reminder scheduling (confirmed):** use **system/Coolify cron on the
  deployment VM** (we have cron available there) to hit an internal
  `dispatchDueReminders` endpoint every ~1–5 min. Due jobs live in a
  `fantasy_scheduled_jobs` table (due_at, kind, payload); the dispatcher is
  idempotent and deploy-resilient (no in-process timers needed for reminders).
  The cron entry is added as part of M4's deploy step on this VM.

### 8.2 Push (later phase)
- Add Web Push: VAPID keys (env `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`),
  `web-push` dep, a `push` event handler in `public/sw.js`, subscription UI,
  and `fantasy_push_subscriptions`. The SW already exists, so this is additive.
- Highest-value push moments: **on the clock** and **draft starting now**.

### 8.3 In-app
- `fantasy_notifications` inbox + an unread badge. Add a toast lib (`sonner`)
  for transient feedback (none exists today).

---

## 9. Real-Time Draft (SSE, no WebSocket)

### 9.1 Why SSE
`proxy.mjs` forwards SSE today and explicitly does **not** handle WS upgrades.
SSE + server-fn picks gives us live broadcast without new infra. Bidirectional
"client→server" is just a server-fn call (`makePick`); "server→clients" is the
SSE stream.

### 9.2 Server
- Route `app/routes/api/fantasy/draft/$leagueId/stream.ts` returns
  `text/event-stream`. On connect, send a full state snapshot, then deltas.
- **In-memory per-league pub/sub** (a `Map<leagueId, Set<controller>>`),
  mirroring the Fate live-bus pattern (`app/fate/server.ts`). DB is source of
  truth; the bus is just fan-out. Support `Last-Event-ID` resume by replaying
  from `current_pick_no`.
- **Pick submission:** server-fn `makePick({leagueId, corpsKey, caption})`:
  - Auth: actor is a member; `draft.current_user_id === actor.userId`;
    `now <= pick_deadline_at`.
  - Validate against U1/U2/U3 + `allowedDivisions` + corps is in the season's
    World/Open pool (pre-season: from the corps directory, not yet scored).
  - Transaction: insert `fantasy_picks`, advance `current_pick_no` /
    `current_user_id` / `pick_deadline_at` (snake/linear math), then **broadcast**
    the delta to the bus.
- **Auto-picker:** when a draft goes live, register a timer keyed to
  `pick_deadline_at`. On expiry (and on each advance), a single authoritative
  `runAutoPickIfDue(leagueId)` selects the **best available legal pick** ranked
  by **prior-season finals caption score** (`rankingSource='prior_season'`,
  confirmed) among allowed, not-yet-taken, legal corps/captions. Corps with no
  prior-season finals score fall to the bottom (alpha tiebreak). The same
  ranking powers the draft-board "suggested pick" hint. Timer is re-derived from
  DB on process start so a deploy mid-draft self-heals.

### 9.3 Concurrency & correctness
- **Single writer per draft:** serialize pick processing per league (an async
  mutex/queue keyed by leagueId) so two simultaneous valid picks can't both
  claim the same slot. The unique indexes (U1) are the backstop.
- **Clock authority is the server.** Clients render a countdown from
  `pick_deadline_at` but never decide expiry.
- **Pause/resume:** owner can pause (e.g. someone disconnects); pausing freezes
  `pick_deadline_at`.

### 9.4 Client
- `useEventSource` hook subscribing to the stream; renders board, available
  pool (filtered by remaining legal options), current picker, countdown, and
  the member's roster. Optimistic UI on own pick; reconcile from broadcast.
- Reconnect with backoff + `Last-Event-ID`.

### 9.5 Draft lifecycle
`scheduled` → (at `scheduled_at`, owner clicks "Start" or auto-start) → `live`
→ picks until every member's `sum(captionCaps)` slots are filled (total rounds =
`sum(captionCaps)`) → `complete` → rosters lock → league `status='active'`.

---

## 10. Scoring & General Edge Cases

- **Corps absent from a show:** no effect — season-best simply isn't updated by
  a show the corps didn't attend. A pick contributes 0 only until that corps
  posts its first score in that caption.
- **A corps' best can only rise:** standings are monotonic through the season
  and stabilize at finals; a late season-best (e.g. a corps peaks at finals)
  retro-improves that pick on the next recompute.
- **Open vs World on same roster:** allowed if both in `allowedDivisions`; note
  scores aren't directly comparable across divisions — surface a disclaimer; we
  use raw caption scores regardless of division (intentional fantasy quirk).
- **Caption renames / missing caption in DB:** map via existing
  `normalizeCaptionKey()`; if a caption is genuinely absent for a show, apply
  `missingCaptionPolicy`.
- **Recap corrections / re-scrapes:** because recompute is idempotent and
  derives from current recap data, a corrected recap simply recomputes correct
  standings on next run. Log standings deltas for transparency.
- **Mid-season corps withdrawal:** picks of a withdrawn corps score 0 going
  forward; no roster edits in v1 (documented; future: injury-replacement rule).
- **Season boundary:** "season complete" determined by presence of the World
  Championship Finals recap for that season; we then lock `is_final`.
- **Empty league / solo league:** allowed; standings trivially rank 1.
- **Tie in standings:** tie-break by GE subtotal, then Music, then earliest
  draft position; surfaced in UI.
- **Draft never started (owner ghosts):** after `scheduled_at + grace`, allow
  any member to trigger auto-start, or owner to reschedule.

---

## 11. Admin (two layers)

### 11.1 Site admin (existing roles)
- New capability `manageFantasyQuiz` (add to `authz.ts` capability matrix,
  min role `moderator`). New capability `manageFantasyLeagues` (min `admin`)
  for support actions (cancel/refund a league, ban abuse).
- Admin routes under `app/routes/admin/fantasy/`:
  - **Quiz bank CRUD** (questions, difficulty, tags, activate/deactivate, bulk
    import via JSON, preview). Protected with `requireCapability(req,
    'manageFantasyQuiz')` (mirror the dev-only guard pattern but role-based).
  - **League ops console:** find league, view members/picks/standings, force
    advance/auto-pick (support), cancel league, issue refund (later), audit log.
- **Audit:** reuse the append-only revision idea — log admin actions to a
  `fantasy_admin_audit` table (who/what/when/before/after).

### 11.2 League owner (in-app, not a site role)
- Setup wizard: name, season, config (§6) with sane defaults + explanations.
- Invite management (mint/revoke links, see who joined).
- Schedule draft (date/time picker; sends reminders).
- Resolve draft order (esp. for `manual`).
- Start/pause draft; kick a member (pre-draft).
- Cannot author quiz questions in v1 (A3).

---

## 12. Payments & Refunds (later phase — design now, build later)

### 12.1 Approach
- Evaluate **PayKit** (advertised better-auth integration → lowest friction
  given we already use better-auth) vs **Stripe + Alchemy**. Decision criteria:
  better-auth fit, refund API ergonomics, webhook reliability, fees.
- Gate `createLeague` behind a successful payment (one-time fee per league per
  season). Reserved columns `payment_status`/`payment_ref` already in schema.

### 12.2 Flow
- Create checkout session → on webhook `paid`, flip `payment_status='paid'` and
  allow league to leave `setup`. Until paid, league exists but is locked
  (can't invite/draft) or isn't created at all (decision: create-then-pay so we
  have an id to attach the session to; clean up unpaid drafts after 24h).

### 12.3 Refund policy (designed)
- **Full refund** if requested **before the draft starts** (`status` in
  `setup/quiz/scheduled`) and within N days of purchase. Self-serve.
- **No refund after draft starts** (`drafting`/`active`) — the product (the
  league experience) has been delivered. Surface this clearly at checkout.
- **Admin-issued refunds** for exceptional cases (outage, abuse) via the ops
  console → calls provider refund API → set `payment_status='refunded'`,
  league `status='canceled'`, members notified, invites revoked.
- **Idempotency:** refund actions keyed by `payment_ref`; webhook handlers
  idempotent (dedupe by event id).
- **Edge:** partial-season outage → manual goodwill refund decision (policy doc
  in `docs/`), not automated in v1 of payments.

### 12.4 Risks
- Webhooks require a publicly reachable endpoint (we have one). Test with
  provider CLI. Never trust client-reported payment status; only webhooks flip
  `paid`. Handle currency, tax, and receipts per provider defaults initially.

---

## 13. Security & Privacy

- All write server-fns: re-validate input server-side (valibot/Effect Schema),
  authorize via `getActor`/membership/ownership checks (never trust client).
- Invite tokens are high-entropy, single-or-limited-use, expiring, revocable.
- Quiz **correct answers never sent to client** pre-scoring; quiz timer
  enforced server-side (reject late submissions).
- Rate-limit invite acceptance and pick submission per user.
- Corps-name/picture uploads go through the existing sharp re-encode (strips
  EXIF/GPS) — reuse as-is.
- Durable-storage fail-closed on all fantasy writes (I-7).
- PII: emails only used for invites/notifications; honor a global opt-out.

---

## 14. Milestones

> Each milestone ends shippable behind a feature flag (`VITE_ENABLE_FANTASY`),
> with tests. Order optimizes for de-risking the join flow and scoring early.

### M0 — Foundations (schema + email helper)
- Add all `fantasy_*` tables to `contributions-db.ts` migrations.
- `app/lib/email.ts` generic `sendEmail` (refactor from `sendMagicLink`).
- `LeagueConfig` valibot schema + defaults; pure scoring functions stubbed.
- Feature flag plumbing.
- **Exit:** migrations run on prod-shaped DB; unit tests for config validation.

### M1 — Leagues + Invites + Join flow
- Server-fns: `createLeague`, `getLeague`, `listMyLeagues`, `createInvite`,
  `revokeInvite`, `acceptInvite`, `setCorpsIdentity`.
- Routes: league dashboard, create wizard, `/fantasy/join/$token`, corps
  identity step. OAuth round-trip cookie handling.
- Invite emails via Resend.
- **Exit:** a user can create a league, invite via link, a second user signs in
  with Google through the link and lands in the league with a corps name+logo.
  Covers invite edge cases in §7.5.

### M2 — Quiz + admin authoring
- Admin quiz CRUD (`manageFantasyQuiz` capability) under `/admin/fantasy`.
- Member quiz run (server-served question set, server-scored, timed).
- Draft-order resolution from `quizOrderDir`.
- **Exit:** admin adds questions; members take the quiz; draft order computes
  correctly for all `quizOrderDir` modes incl. ties and non-takers.

### M3 — Draft engine + realtime (SSE)
- SSE stream route + in-memory bus; `makePick`; snake/linear advance; per-league
  serialization; auto-picker timer + self-heal on restart; pause/resume.
- Draft UI: board, pool (legal-filtered), countdown, roster.
- Roster-rule enforcement (U1/U2/U3, divisions, reverse-weighting weights).
- **Exit:** a scheduled draft runs end-to-end with multiple concurrent clients,
  auto-pick fires on timeout, picks are unique and legal, survives a server
  restart mid-draft.

### M4 — Scoring + standings + notifications
- `captionSeasonBest` / `computeRosterScore` (§5.3 weighted-average → DCI math) /
  season recompute; hook into `scrapeWebsiteRecapsForSeason`.
- `fantasy_standings` writes; **recap-style leaderboard**: render each member as
  a row in the real recap table (reuse `app/components/prediction/score-recap-table.tsx`
  + the `SCORE_COLUMNS` Total/GE/Visual/Music + 8-caption layout), so a league's
  standings read exactly like a DCI recap (totals ≤ 100). The member's
  corps_name/show_title/logo/color theme their row. `breakdown_json` drives an
  expandable per-caption view showing which corps + weight produced each caption
  cell.
- Standings/season-complete notifications (digested email); scheduled draft
  reminders via `fantasy_scheduled_jobs` + `dispatchDueReminders`.
- **Exit:** running a scrape recomputes standings idempotently against a 2024
  fixture; leaderboard matches hand-computed golden values; final lock works.

### M5 — Push notifications (optional/later)
- VAPID, `web-push`, SW `push` handler, subscription UI,
  `fantasy_push_subscriptions`, on-the-clock + draft-start pushes.

### M6 — Payments + refunds (later)
- Provider decision (PayKit vs Stripe+Alchemy), checkout gate on
  `createLeague`, webhooks, self-serve + admin refunds per §12.

---

## 15. Success Criteria

**Functional**
- A non-technical user creates a league and invites 5 friends; ≥90% complete
  the join (sign-in → in league with corps identity) without help.
- Draft of 8 members × 8 rounds completes with zero illegal/duplicate picks and
  correct auto-picks on timeouts.
- After a real scrape, standings recompute within the scrape job and match
  golden-fixture expectations to ±0.001.
- Quiz order honors `high_first`/`low_first` exactly; non-takers handled.

**Non-functional**
- Draft pick→broadcast latency < 500ms p95 (single-region, single process).
- SSE clients reconnect and resync without losing picks (Last-Event-ID).
- No fantasy write succeeds when the durable volume is absent (fail-closed).
- Scoring functions are pure and 100%-covered by unit tests.
- No correct-answer leakage in any quiz network payload (verified by test).

**Quality gates**
- All new server-fns authorize + re-validate; reviewed against §13.
- `docs/dci_domain.md` math reproduced exactly at default weights (golden test).

---

## 16. Variance / Open Questions / Risks

- **V1 (multi-process):** the SSE bus + auto-pick timers assume one Node
  process (A8). If we scale horizontally, we need a shared pub/sub (e.g.
  libsql polling, Redis, or sticky routing). **Decision needed before scaling.**
- **V2 (reminder scheduling):** RESOLVED — system/Coolify **cron on the
  deployment VM** hits `dispatchDueReminders`; jobs in `fantasy_scheduled_jobs`.
  (Auto-pick during a live draft still uses an in-process timer per §9.2.)
- **V3 (config-after-draft):** RESOLVED — the owner **can edit scoring weights
  up until finals week** (`weightsLockedAt='finals_week'`). Recompute always
  uses current weights; weights lock once the finals recap lands.
- **V4 (cross-division comparability):** RESOLVED — World **and** Open Class
  only (no All-Age / SoundSport). Mixing World/Open caption scores is an
  intentional quirk.
- **V5 (reverse-weighting semantics):** RESOLVED — *save the best for last,
  across the whole roster*: weight ramps by your **overall pick round**
  (linear `minWeight`→`maxWeight`, default 1.0→2.0), NOT by caption. Optimal to
  draft lower corps early and hold elites for late, high-weight rounds — which
  rivals can snipe early. On by default. See §6 / Appendix E.2.
- **V6 (scoring resolution):** RESOLVED — a pick's value is the **highest score
  that corps has previously scored in that caption** this season (season-best to
  date), not a per-show sum. See §5.2.
- **V7 (payments provider):** PayKit vs Stripe+Alchemy — needs a spike to
  compare better-auth integration + refund ergonomics.
- **V8 (open-class data coverage):** RESOLVED per owner — Open Class is
  reliably scraped into `caption_scores`; still worth a quick spot-check during
  M4 against a real Open Class recap.
- **V9 (abuse):** shareable multi-use invite links could leak publicly; mitigate
  with expiry + max_uses + owner revoke + league-full guard.

---

## 17. File/Module Map (where new code lands)

```
app/lib/contributions-db.ts        # + fantasy_* CREATE TABLE migrations
app/lib/email.ts                   # generic sendEmail (refactored from auth.ts)
app/lib/fantasy/
  config.ts                        # LeagueConfig schema + defaults
  scoring.ts                       # pure captionSeasonBest / computeRosterScore
  draft.ts                         # snake/linear advance, auto-pick heuristic
  bus.ts                           # in-memory per-league SSE pub/sub
  invites.ts                       # token mint/validate/accept (race-safe)
app/lib/server-fns/fantasy.ts      # league/member/invite/quiz/pick server-fns
app/routes/fantasy/
  index.tsx                        # my leagues
  $slug/index.tsx                  # league dashboard
  $slug/draft.tsx                  # draft room (SSE client)
  $slug/standings.tsx              # recap-style leaderboard (reuse score-recap-table)
  create.tsx                       # setup wizard
  join/$token.tsx                  # invite landing + OAuth round-trip
app/routes/api/fantasy/
  draft/$leagueId/stream.ts        # SSE endpoint
  jobs/dispatch.ts                 # cron-hit reminder dispatcher (M4)
app/routes/admin/fantasy/
  quiz.tsx                         # quiz bank CRUD (manageFantasyQuiz)
  leagues.tsx                      # ops console (manageFantasyLeagues)
sdk/src/websiteScraper.ts          # + recompute hook after season ingest
sdk/src/fantasyStandings.ts        # recomputeFantasyStandingsForSeason
app/lib/authz.ts                   # + manageFantasyQuiz / manageFantasyLeagues caps
public/sw.js                       # + push handler (M5)
```

---

## 18. Test Strategy

- **Unit (pure):** scoring math (golden 2024 fixture), config validation,
  draft-order resolution, snake/linear advance, reverse-weighting.
- **Integration:** invite accept race (concurrent accepts respect max_uses),
  pick uniqueness under concurrency, idempotent recompute, OAuth-token-survival
  through a simulated redirect.
- **E2E (happy path):** create→invite→join(Google)→quiz→draft→scrape→standings.
- **Security:** quiz answer non-leakage; authz on every server-fn; durable
  fail-closed.
```

---

## 19. Open Questions & Considerations (read before building — not yet settled)

§16 covers the *design-variance* items that are now RESOLVED or explicitly
deferred. This section is the honest list of things that are still **vague,
under-specified, or unverified** — where we do **not** yet have enough
information to make a confident move. Each item says: what's unclear, why it
matters, and the **provisional default** to use so building isn't blocked.
**If you hit one of these while building, follow the provisional default and
leave a `// TODO(plan-gap: <id>)` comment** — do not silently invent a richer
behavior.

### 19.1 Decisions that genuinely need the product owner

- **Q1 — Scoring mode: RESOLVED.** Scores must look like a real recap (≤ 100).
  Per-caption value is a **weighted average** (`Σ(v·w)/Σ(w)`, divide by sum of
  weights), which is always ≤ the caption max, so the DCI total stays ≤ 100 while
  reverse-weighting still biases the average toward high-weight picks. Default
  mode `recap`. The `sum` mode (unbounded points pile) exists but is off by
  default. See §5.3 / Appendix D. No open question remains here.
- **Q2 — Cross-division comparability (World vs Open).** Open Class corps score
  materially lower than World Class on the same sheet. Allowing both on one
  roster (confirmed) means an Open pick almost never out-scores a World pick, so
  rational drafters just ignore Open. *Open:* do we want a handicap/normalization
  for Open picks, or is "Open is a trap option" acceptable? **Provisional: no
  normalization; raw scores; add a UI disclaimer.** Revisit after a test season.
- **Q3 — Score scale: RESOLVED (no longer an issue in `recap` mode).** The
  weighted-average normalization (Q1) keeps every caption ≤ its max and the total
  ≤ 100 even with reverse-weighting ON, so the leaderboard renders as a real
  recap. Only the optional `sum` mode is unbounded; if a league uses it, label
  that leaderboard "Fantasy points," not a 0–100 score.
- **Q4 — Which "finals" ends the season?** Open Class has its own finals earlier
  in championship week than World finals. *Open:* does a league's season complete
  at World finals (later) or when its allowed divisions have all finished?
  **Provisional: World Championship Finals date (latest), per §5.5.** Also the
  slug match `%world-championship-finals` is heuristic — verify the exact 2026
  finals `slug`/`date` in `dci-relational.db` during M4 before trusting it.
- **Q5 — Same quiz questions for everyone, or randomized per member?** Draft
  order fairness depends on this. Different per-member question sets mean luck of
  the draw even with difficulty-weighting. **Provisional: serve the SAME frozen
  set to every member in a league** (simpler, fairer); revisit if owner wants
  anti-cheating variety.

### 19.2 Real risks / couplings to resolve early (technical, not product)

- **R1 — Logo upload must NOT reuse `uploadShowMedia` as-is.** That function is
  coupled to the show-wiki: it calls `ensureShowPage` (creating a bogus
  `show_pages` row), requires the `'upload'` capability, and writes to
  `show_media` keyed by `page_id`. Using it for fantasy corps logos would
  pollute wiki data. **Action:** build a dedicated `uploadFantasyLogo` server-fn
  that reuses only the low-level pieces — the sharp→WebP re-encode and
  `putUpload()`/`uploadKey()` from `app/lib/r2.ts` — and stores the row in a
  small `fantasy_media` table (or adds `league_id`/`user_id` columns), served by
  a new `/api/fantasy-media/$id` route mirroring `/api/show-media/$id`. **This
  changes the plan**: §7.4 and the file map should add `fantasy_media` +
  `uploadFantasyLogo` rather than "reuse `uploadShowMedia`." (Add the
  `fantasy_media` DDL alongside Appendix B when implementing M1.)
- **R2 — Two processes writing `contributions.db`.** The app serves writes; the
  standings recompute runs in the **scrape/SDK process** (Appendix C.5), so two
  OS processes may write the same SQLite file. WAL + `busy_timeout=5000`
  (already set) supports this *on the same host/filesystem*. **Verify** the
  scrape actually runs on the same VM with the same `/data` mount (it should). If
  the scrape ever runs elsewhere, recompute must instead call an internal
  authenticated app endpoint rather than open the file directly.
- **R3 — "After every show" depends on the scrape cadence.** The recap scraper
  is currently **manual / externally triggered** (`scrapeWebsiteRecaps.ts`),
  not a built-in cron. So standings only refresh when the scrape runs. *Open:*
  is there (or will there be) a scheduled scrape? **Provisional: standings
  refresh whenever the existing scrape runs; if precise daily updates are
  wanted, add a cron for the scrape itself (separate from the reminder cron).**
- **R4 — Draft pool exhaustion / unfillable rosters.** With caption caps,
  one-caption-per-corps, and M members, the draft needs enough unique
  `(corps,caption)` combinations *and* enough distinct corps per member. A small
  pool or many members could make a roster unfillable, and the auto-picker could
  get stuck. **Action:** `startDraft` must pre-validate feasibility
  (`pool size >= worst-case demand`) and refuse to start with a clear message;
  the auto-picker must have a defined fallback (skip the slot, leaving it empty
  → scores 0) if no legal pick exists. **Provisional: validate at start; empty
  slot scores 0 if truly unfillable.**
- **R5 — Caption score scale assumption.** Scoring math assumes each stored
  `caption_scores.score` is on the on-sheet ~20-point basis (GE1/GE2 each ~20,
  Visual/Music captions each ~20). **Verify** against real 2025 finals rows
  before trusting Appendix D (spot-check that Blue Devils' MB is ~19, not a raw
  judge box of ~95). If the stored scale differs, adjust the formulas, not the
  data.
- **R6 — SSE connection limits.** Browsers cap ~6 concurrent HTTP/1.1
  connections per origin; multiple draft tabs + normal browsing could starve.
  Low risk for small leagues. **Provisional: one EventSource per draft page;
  document "use one tab for the draft."** Revisit if HTTP/2 isn't in play behind
  the proxy.

### 19.3 Under-specified / deferred (fine to leave, but don't pretend they're done)

- **D1 — `missingCaptionPolicy: 'prorate'`** is named but undefined. v1
  implements only `'zero'`; `'prorate'` should throw "not implemented" or be
  hidden in the UI until specified.
- **D2 — Quiz bank minimum size.** If fewer active questions exist than
  `questionCount`, behavior is undefined. **Provisional: serve as many as exist
  (min 1) and scale `max_score` accordingly; block enabling the quiz with 0
  questions.** A sensible minimum bank (e.g. 30+) is a content task, not code.
- **D3 — Scheduled-draft time zones.** `scheduled_at` is stored ISO-UTC, but how
  the owner picks it and how reminders/countdowns render in members' local time
  is unspecified. **Provisional: store UTC; render in the browser's local tz;
  owner picks via a date-time control that submits UTC.**
- **D4 — Late joiners after the draft is scheduled.** Allowed to join until the
  draft starts, but quiz availability and draft-position assignment for someone
  who joins after others have taken the quiz is fuzzy. **Provisional: they can
  still take the quiz until `startDraft`; order is resolved once at start from
  whoever has a score then; non-takers sort last (E.1).**
- **D5 — Profanity/abuse moderation** of corps names, show titles, and logos is
  "optional" in §7.4. No filter is specified. **Provisional: none in v1; rely on
  the league being private + owner/admin removal. Add the `manageFantasyLeagues`
  admin take-down path (already in §11.1).**
- **D6 — Email deliverability & "from" identity.** Fantasy emails reuse Resend;
  the `from` domain and per-league vs per-user opt-out granularity aren't
  decided. **Provisional: reuse `MAGIC_LINK_FROM` (or a new
  `FANTASY_EMAIL_FROM` if set); honor a single per-user global opt-out flag.**
- **D7 — League lifecycle across seasons.** Leagues are single-season; whether a
  league can "roll over" to next season (re-invite, re-draft) is out of scope.
  **Provisional: a new season = a new league.**
- **D8 — Account/email mismatch on invite.** Email-bound invites are "soft"
  (§7.5) — a user signing in with a different Google account than the invited
  email is allowed with a warning. Confirm that's desired vs. strict binding.

### 19.4 Things to verify in code during M1 (not blockers, just confirm)

- `BETTER_AUTH_URL` is the real public origin in prod, and `signIn.social`
  `callbackURL` to `/fantasy/join/<token>` is accepted (else add
  `trustedOrigins`) — Appendix G.1.
- The `SameSite=Lax` `fantasy_invite` cookie survives the Google round-trip in
  prod (it should for a top-level GET redirect; test it).
- Adding fields to better-auth's `user` (none needed) vs. reading the existing
  `role` field works as in `getActor`.

> **Implementation begins only after this plan is reviewed and the open items in
> §16 (variance) and §19 (open questions) are acknowledged.** §19.1 (Q1–Q5)
> ideally get owner answers before M3/M4; §19.2 (R1–R6) are the executor's
> responsibility to handle per their provisional defaults and flag if reality
> differs.

---
---

# PART II — EXECUTION REFERENCE (literal; follow exactly)

Everything below is precise and copy-pasteable. All file paths are absolute
under `/root/corps-place`. All code matches the existing codebase conventions
(verified against real files).

## Appendix A — Environment variables

These already exist (do not change them; you only read them):
- `CONTRIBUTIONS_DB_URL` — libsql URL for the writable DB. Prod:
  `file:/data/contributions.db`. Dev fallback: `file:<repo>/sdk/contributions.db`.
- `DCI_RELATIONAL_DB_URL` — libsql URL for the read-only score DB. Dev fallback:
  `file:<repo>/sdk/dci-relational.db`.
- `BETTER_AUTH_URL` — base URL of the site (e.g. `https://drumcorps.app` in prod,
  `http://localhost:5173` in dev). Used to build OAuth callback origins.
- `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — auth.
- `RESEND_API_KEY`, `MAGIC_LINK_FROM` — email (Resend). If `RESEND_API_KEY` is
  unset, email helpers must log to console and return (mirror `sendMagicLink`).
- `R2_ENDPOINT` / `R2_BUCKET` / `R2_UPLOAD_PREFIX` / `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` — R2 image storage (already used by `app/lib/r2.ts`).

New (add to `.env` and prod env; document in README):
- `VITE_ENABLE_FANTASY` — `'true'` to enable the feature. Default off.
- `FANTASY_CRON_SECRET` — shared secret the cron job sends as a header to the
  `dispatchDueReminders` endpoint so it can't be called by the public (Appendix
  H.4 / §8.1).
- (M5, later) `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — web push.

## Appendix B — Literal SQL DDL (paste into `contributions-db.ts` `SCHEMA`)

Append these strings to the existing `SCHEMA` array in
`app/lib/contributions-db.ts` (after the `show_*` statements, before the closing
`]`). They are additive and idempotent. CaptionKey values are stored as the
8 keys (`'GE1'`…`'MP'`), never the long names.

```sql
-- 4.1
CREATE TABLE IF NOT EXISTS fantasy_leagues (
  league_id      TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  season         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'setup',  -- setup|quiz|scheduled|drafting|active|complete|canceled
  config_json    TEXT NOT NULL,                  -- validated LeagueConfig (Appendix E.0)
  max_members    INTEGER NOT NULL DEFAULT 12,
  payment_status TEXT NOT NULL DEFAULT 'none',   -- none|paid|refunded (reserved)
  payment_ref    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fantasy_leagues_owner  ON fantasy_leagues (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fantasy_leagues_season ON fantasy_leagues (season, status);

-- 4.2
CREATE TABLE IF NOT EXISTS fantasy_members (
  league_id           TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'member', -- owner|member
  corps_name          TEXT,
  show_title          TEXT,
  corps_logo_media_id TEXT,
  corps_color         TEXT,
  quiz_score          REAL,
  draft_position      INTEGER,
  status              TEXT NOT NULL DEFAULT 'active', -- active|removed
  joined_at           TEXT NOT NULL,
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_fantasy_members_user ON fantasy_members (user_id);

-- 4.3
CREATE TABLE IF NOT EXISTS fantasy_invites (
  invite_id   TEXT PRIMARY KEY,
  league_id   TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  email       TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fantasy_invites_league ON fantasy_invites (league_id);

-- 4.4
CREATE TABLE IF NOT EXISTS fantasy_quiz_questions (
  question_id    TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  choices_json   TEXT NOT NULL,           -- JSON array of 2..6 strings
  correct_index  INTEGER NOT NULL,
  explanation    TEXT,
  difficulty     TEXT NOT NULL,           -- easy|medium|hard
  tags_json      TEXT NOT NULL DEFAULT '[]',
  active         INTEGER NOT NULL DEFAULT 1,
  author_user_id TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fantasy_questions_active ON fantasy_quiz_questions (active, difficulty);

-- 4.5
CREATE TABLE IF NOT EXISTS fantasy_quiz_attempts (
  attempt_id       TEXT PRIMARY KEY,
  league_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  question_ids_json TEXT NOT NULL,        -- ordered JSON array of question_id served
  answers_json     TEXT NOT NULL DEFAULT '[]', -- ordered JSON array of chosen indexes
  raw_score        REAL,
  max_score        REAL,
  weighted_score   REAL,                  -- raw/max, 0..1
  started_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fantasy_attempt_completed
  ON fantasy_quiz_attempts (league_id, user_id) WHERE completed_at IS NOT NULL;

-- 4.6
CREATE TABLE IF NOT EXISTS fantasy_drafts (
  draft_id        TEXT PRIMARY KEY,
  league_id       TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|live|paused|complete
  scheduled_at    TEXT,
  order_json      TEXT,                  -- JSON array of user_id (base round-1 order)
  draft_type      TEXT NOT NULL,         -- snake|linear (frozen from config)
  pick_seconds    INTEGER NOT NULL DEFAULT 60,
  total_rounds    INTEGER NOT NULL,      -- = sum(captionCaps)
  current_pick_no INTEGER NOT NULL DEFAULT 0, -- 0-based global counter
  current_user_id TEXT,
  pick_deadline_at TEXT,
  started_at      TEXT,
  completed_at    TEXT
);

-- 4.7
CREATE TABLE IF NOT EXISTS fantasy_picks (
  pick_id           TEXT PRIMARY KEY,
  league_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  corps_key         TEXT NOT NULL,
  caption           TEXT NOT NULL,       -- one of the 8 keys
  round             INTEGER NOT NULL,
  pick_no           INTEGER NOT NULL,
  caption_slot_index INTEGER NOT NULL,   -- 1-based within (user, caption)
  weight            REAL NOT NULL DEFAULT 1.0,
  auto_picked       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
-- U1: a (corps,caption) is owned by at most one member in a league
CREATE UNIQUE INDEX IF NOT EXISTS uq_fantasy_pick_corps_caption
  ON fantasy_picks (league_id, corps_key, caption);
-- U2: one caption per corps per member (only enforced as unique when oneCaptionPerCorps=true;
-- always create the index — when the config disables U2, the app must NOT insert a duplicate
-- corps for a member anyway under default config; if a league sets oneCaptionPerCorps=false,
-- skip relying on this index and enforce caps in app logic. For v1 default (true) keep it.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fantasy_pick_user_corps
  ON fantasy_picks (league_id, user_id, corps_key);
CREATE INDEX IF NOT EXISTS idx_fantasy_picks_user ON fantasy_picks (league_id, user_id);

-- 4.8
CREATE TABLE IF NOT EXISTS fantasy_standings (
  league_id              TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  through_competition_slug TEXT,
  total_score            REAL NOT NULL DEFAULT 0,
  ge_score               REAL NOT NULL DEFAULT 0,
  visual_score           REAL NOT NULL DEFAULT 0,
  music_score            REAL NOT NULL DEFAULT 0,
  breakdown_json         TEXT NOT NULL DEFAULT '{}',
  rank                   INTEGER,
  computed_at            TEXT NOT NULL,
  is_final               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (league_id, user_id)
);

-- 4.9
CREATE TABLE IF NOT EXISTS fantasy_notifications (
  notif_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  league_id    TEXT,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  read_at      TEXT,
  email_sent_at TEXT,
  push_sent_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fantasy_notifs_user ON fantasy_notifications (user_id, read_at);

-- 4.10 (reserved; empty until M5)
CREATE TABLE IF NOT EXISTS fantasy_push_subscriptions (
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);

-- scheduled jobs (drives draft reminders + season-complete via cron, Appendix H.4)
CREATE TABLE IF NOT EXISTS fantasy_scheduled_jobs (
  job_id      TEXT PRIMARY KEY,
  league_id   TEXT,
  kind        TEXT NOT NULL,         -- draft_soon_60|draft_soon_10|draft_start|...
  due_at      TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  done_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fantasy_jobs_due ON fantasy_scheduled_jobs (done_at, due_at);

-- admin audit
CREATE TABLE IF NOT EXISTS fantasy_admin_audit (
  audit_id    TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action      TEXT NOT NULL,
  league_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);
```

## Appendix C — Score-DB facts and exact queries

### C.1 Caption key ↔ DB string mapping (authoritative)

The score DB (`caption_scores.caption_name`) stores the long strings on the
left; map to keys on the right. Build this constant in
`app/lib/fantasy/captions.ts` and use it for all score lookups:

```ts
export const CAPTION_KEYS = ['GE1','GE2','VP','VA','CG','MB','MA','MP'] as const;
export type CaptionKey = (typeof CAPTION_KEYS)[number];

// DB caption_name string  ->  CaptionKey
export const CAPTION_NAME_TO_KEY: Record<string, CaptionKey> = {
  'General Effect 1':   'GE1',
  'General Effect 2':   'GE2',
  'Visual Proficiency': 'VP',
  'Visual - Analysis':  'VA',
  'Color Guard':        'CG',
  'Music - Brass':      'MB',
  'Music - Analysis':   'MA',
  'Music - Percussion': 'MP',
};
// Reverse, for building SQL IN-lists when you need to query by name:
export const KEY_TO_CAPTION_NAME: Record<CaptionKey, string> =
  Object.fromEntries(Object.entries(CAPTION_NAME_TO_KEY).map(([n, k]) => [k, n])) as any;

// Which DCI category each caption rolls into:
export const CAPTION_CATEGORY: Record<CaptionKey, 'ge'|'visual'|'music'> = {
  GE1:'ge', GE2:'ge', VP:'visual', VA:'visual', CG:'visual', MB:'music', MA:'music', MP:'music',
};
```

Defensive note: a few historical rows may store slightly different strings. If a
`caption_name` is not in the map, fall back to the existing `normalizeCaptionKey`
logic (`sdk/src/readModel/builders/recap.ts`) — but for v1 the 8 strings above
cover all current-era data.

### C.2 `captionSeasonBest` — a corps' best score in one caption this season

Returns, for the season up to now, the MAX score each `(corps_key, caption)` has
posted at any **World/Open** competition. Run once per recompute and build an
in-memory lookup `Map<\`${corps_key}|${captionKey}\`, number>`.

```sql
SELECT cap.corps_key, cap.caption_name, MAX(cap.score) AS best
FROM caption_scores cap
JOIN competitions c   ON c.slug = cap.competition_slug
JOIN corps_scores cs  ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
WHERE c.season = ?                                   -- e.g. '2026'
  AND cs.division_name IN ('World Class','Open Class')
  AND cap.score IS NOT NULL
GROUP BY cap.corps_key, cap.caption_name;
```
Map each `caption_name` to a `CaptionKey` via C.1; ignore unmapped names.

### C.3 Prior-season finals ranking (for pre-season draft auto-pick + suggestions)

For each `(corps_key, captionKey)`, the corps' caption score at the **previous**
season's World Championship Finals. Used to rank the draft pool.

```sql
SELECT cap.corps_key, cap.caption_name, cap.score
FROM caption_scores cap
JOIN competitions c  ON c.slug = cap.competition_slug
JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
WHERE c.season = ?                                   -- (currentSeason - 1), e.g. '2025'
  AND c.slug LIKE '%world-championship-finals'
  AND cs.division_name IN ('World Class','Open Class')
  AND cap.score IS NOT NULL;
```
A corps/caption with no row ranks last (sort key = `-Infinity`), alpha tiebreak
by corps name. (Open Class corps typically won't appear in the *World* finals;
that's fine — they sort to the bottom of the pre-season ranking. The ranking is
only a draft *suggestion / auto-pick* aid, not a scoring input.)

### C.4 Draftable corps pool (active World + Open for the season)

```sql
SELECT corps_key, slug, name, division_name, display_city, corps_logo
FROM corps
WHERE division_name IN ('World Class','Open Class')
ORDER BY division_name, name COLLATE NOCASE;
```
(If you need "active this season only," intersect with the corps-directory
builder's `active_corps` CTE — see `sdk/src/readModel/builders/corps.ts`. For v1
the simple list above is acceptable; corps that never score just never
contribute points.)

### C.5 Opening the read-only score DB

In `sdk/src/fantasyStandings.ts` (which runs in the scrape/SDK process), open
both DBs with their own clients — do NOT import `app/lib` from the SDK:

```ts
import { createClient } from '@libsql/client';
import * as path from 'node:path';
const scoreDb = createClient({
  url: process.env.DCI_RELATIONAL_DB_URL
    ?? `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`,
});
const contribDb = createClient({
  url: process.env.CONTRIBUTIONS_DB_URL
    ?? `file:${path.resolve(process.cwd(), 'sdk', 'contributions.db')}`,
});
```

## Appendix D — Scoring algorithm (literal, with a worked example)

Implement in `app/lib/fantasy/scoring.ts` as **pure functions** (no DB, no I/O):

```ts
type Pick = { corpsKey: string; caption: CaptionKey; captionSlotIndex: number; weight: number };
type Weights = { ge: number; visual: number; music: number };          // e.g. {40,30,30}
type ScoringMode = 'weighted_sum' | 'dci_average' | 'single_pick';
type SeasonBest = (corpsKey: string, caption: CaptionKey) => number;   // 0 if none

// Returns { total, ge, visual, music, perCaption } for one member's roster.
function computeRosterScore(
  picks: Pick[], best: SeasonBest, weights: Weights, mode: ScoringMode
)
```

Steps (apply for **all** modes unless noted):

1. **Per-pick value:** `v = best(pick.corpsKey, pick.caption)`. If the corps has
   no season-best in that caption yet, `v = 0`.
2. **Reverse-weight:** `wv = v * pick.weight`. (`pick.weight` is precomputed at
   draft time per Appendix E.2; default 1.0.)
3. **Per-caption WEIGHTED AVERAGE** — group picks by `caption`. For caption `c`
   with picks `i = 1..N`, weights `wᵢ` and per-pick values `vᵢ`:
   - `cap[c] = Σ(vᵢ · wᵢ) / Σ(wᵢ)`   ← **divide by the SUM OF WEIGHTS** (not N).
   - This guarantees `cap[c] ≤ 20` (a weighted average of ≤20 values).
   - `N == 1` → `cap[c] = v₁`. `Σ(wᵢ) == 0` or no picks → `cap[c] = 0`.
   - `mode === 'sum'` only: skip the divide entirely, `cap[c] = Σ(vᵢ · wᵢ)`
     (unbounded; non-recap). Default `recap` always divides.
   Missing caption: `cap[c] = 0` (`missingCaptionPolicy` `'zero'`; `'prorate'`
   is deferred — v1 implements `'zero'`).
4. **Category subtotals (real DCI formula):**
   - `geRaw     = cap.GE1 + cap.GE2`                       (each ≤ 20 → ≤ 40)
   - `visualRaw = (cap.VP + cap.VA + cap.CG) / 2`          (≤ 60 → ≤ 30)
   - `musicRaw  = (cap.MB + cap.MA + cap.MP) / 2`          (≤ 60 → ≤ 30)
5. **Apply configurable weights** (default GE 40 / Visual 30 / Music 30; **must
   sum to 100** — normalize if not). Scale each category:
   - `ge     = geRaw     * (weights.ge     / 40)`
   - `visual = visualRaw * (weights.visual / 30)`
   - `music  = musicRaw  * (weights.music  / 30)`
   (Default weights leave scores unchanged; GE 60/Vis 20/Mus 20 → GE ×1.5,
   Visual/Music ×0.667. Since weights sum to 100, max total stays exactly 100.)
6. `total = ge + visual + music` (≤ 100 in `recap` mode). Return all parts +
   `perCaption` for the recap-style UI.

**Worked example** (default weights 40/30/30, one pick per caption, all weight
1.0). Season-bests:
`GE1=19.4, GE2=19.2, VP=19.0, VA=18.8, CG=18.5, MB=19.3, MA=19.1, MP=18.9`.
- cap[c] = vᵢ for each (single pick).
- geRaw = 19.4 + 19.2 = **38.6**
- visualRaw = (19.0 + 18.8 + 18.5) / 2 = 56.3/2 = **28.15**
- musicRaw = (19.3 + 19.1 + 18.9) / 2 = 57.3/2 = **28.65**
- weights default → ge=38.6, visual=28.15, music=28.65
- **total = 95.40** (a believable recap score).

**Worked example with caps + round reverse-weighting (the key one).** Reverse-
weighting ramps weight by overall draft round (§6/E.2), 1.0→2.0 over `R` rounds,
NOT by caption. `R=14`, default ramp. Member's `MP` cap = 2. They saved an elite
for round 14 (`w = 1 + (14-1)/13 = 2.0`) and took a weaker corps in round 2
(`w = 1 + (2-1)/13 ≈ 1.077`):
- BD `MP`=19.3 at w=2.0; weaker `MP`=17.0 at w=1.077.
- `cap.MP = (19.3·2.0 + 17.0·1.077) / (2.0 + 1.077) = 56.91 / 3.077 = `**`18.49`**
  — on the 0–20 scale. ✅ (Then musicRaw = (cap.MB + cap.MA + 18.49)/2, etc.)
- If they'd flipped the weights (elite at 1.077, weak at 2.0):
  `(19.3·1.077 + 17.0·2.0)/3.077 = 54.78/3.077 = `**`17.80`** — strictly lower.
  So saving the elite for the high-weight round still pays, and a rival could
  have sniped BD `MP` in one of their own earlier (lower-weight) rounds to deny
  it. The score stays recap-realistic either way.

## Appendix E — Config, draft order, reverse-weight, quiz (literal)

### E.0 `LeagueConfig` defaults (the exact object to write when a league is created)

```ts
const DEFAULT_CONFIG: LeagueConfig = {
  draftType: 'snake',
  pickSeconds: 60,
  quizOrderDir: 'high_first',
  captionCaps: { GE1:1, GE2:1, VP:2, VA:2, CG:2, MB:2, MA:2, MP:2 }, // sum = 14 rounds
  oneCaptionPerCorps: true,
  allowedDivisions: ['world','open'],
  reverseWeighting: { enabled: true, minWeight: 1.0, maxWeight: 2.0 },
  scoringMode: 'recap',          // weighted-avg per caption → DCI math, total <= 100
  weights: { ge: 40, visual: 30, music: 30 }, // must sum to 100 (validated/normalized)
  weightsLockedAt: 'finals_week',
  missingCaptionPolicy: 'zero',
  draftPhase: 'preseason',
  rankingSource: 'prior_season',
  notify: { email: true, push: false },
  quiz: { enabled: true, questionCount: 10, perQuestionSeconds: 30 },
};
```
Validate every config with a valibot schema mirroring this shape; reject unknown
fields; clamp `pickSeconds` to [15, 600], `questionCount` to [1, 50], each
`captionCaps` value to [0, 10], `weights` each to [0, 100] **and normalize the
three `weights` to sum to 100** (so max total = 100); require
`maxWeight >= minWeight >= 0`.

### E.1 Draft order resolution (run once, when owner starts/locks the draft)

Input: members with `quiz_score` (0..1 or null). Output: `order_json` =
ordered array of `user_id` for round 1.
1. Split into `took` (quiz_score not null) and `missed` (null).
2. Sort `took` by `quiz_score`: `high_first` → descending; `low_first` →
   ascending; `random` → stable seeded shuffle (seed = league_id hash);
   `manual` → use the owner-provided order verbatim.
3. Tie-break within equal scores by `completed_at` ascending (earlier finisher
   first), then by `user_id` ascending.
4. Append `missed` (shuffled by seed) after `took`.
5. `total_rounds = sum(captionCaps values)`.

### E.2 Snake vs linear pick sequence + slot index + weight (the core draft math)

Given `order = [u0,u1,...,u(M-1)]` (M members) and `total_rounds = R`:
- Global pick `n` (0-based) is in `round = floor(n / M)` (0-based) and
  `posInRound = n % M`.
- **linear:** `userAt(n) = order[posInRound]`.
- **snake:** even rounds (0,2,4…) go forward `order[posInRound]`; odd rounds go
  reverse `order[M-1-posInRound]`.
- Draft is complete after `M * R` picks.

When a member makes a pick on caption `c`:
- `round` = (count of that member's existing picks) + 1 (1-based; equals the
  draft round, since each member picks exactly once per round). Store it.
- `caption_slot_index` = (count of that member's existing picks with caption `c`)
  + 1. Used ONLY to enforce caps. Reject if it would exceed `captionCaps[c]`.
- **weight (reverse-weighting by overall round, §6):** if
  `reverseWeighting.enabled` and `R > 1`,
  `weight = minWeight + (maxWeight - minWeight) * (round - 1) / (R - 1)`
  (so round 1 → `minWeight`, round `R` → `maxWeight`; default 1.0 → 2.0).
  If disabled or `R == 1`, `weight = minWeight` (default 1.0). Store on the row.
  Note: weight depends on `round`, NOT on `caption_slot_index`.

Legality of a pick `(corpsKey, caption)` for member U in league L:
1. caption ∈ the 8 keys and `captionCaps[caption] > slotsUsedByU(caption)`.
2. corps is in the pool (Appendix C.4) and in `allowedDivisions`.
3. No existing pick in L with same `(corpsKey, caption)` (U1).
4. If `oneCaptionPerCorps`, U has no existing pick with same `corpsKey` (U2).

### E.3 Quiz scoring (server-side only; answers never sent to client)

- Serve question set: pick `questionCount` active questions. Default mix by
  difficulty when enough exist: 40% easy, 40% medium, 20% hard (round to counts;
  if a bucket is short, backfill from others). Freeze the chosen `question_id`
  order into `question_ids_json` at `started_at`. **Send prompts + choices only —
  never `correct_index`.**
- Difficulty weight: easy=1, medium=2, hard=3.
- On submit (server): for each served question, if `answers[i] === correct_index`
  add its difficulty weight to `raw_score`; `max_score` = sum of all served
  weights; `weighted_score = raw_score / max_score`. Reject submit if
  `now - started_at > questionCount * perQuestionSeconds + grace(30s)` or if an
  attempt already has `completed_at`.

## Appendix F — Server-function catalog (exact contracts)

### F.0 The pattern to copy (verbatim shape from `contrib.ts`)

```ts
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';

const CreateLeagueInput = v.object({ name: v.string(), season: v.string() /* ... */ });

export const createLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateLeagueInput, d))
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    const db = await getContributionsDb();
    // ... db.execute({ sql, args }) ...
    return { ok: true as const, /* ... */ };
  });
```
Notes: GET-only reads may use `{ method: 'GET' }`. Throw `Error('FORBIDDEN')` /
`Error('NOT_FOUND')` / `Error('CONFLICT')` with these exact messages so the
client can branch on them.

### F.1 Catalog (method · input · auth · effect · returns · errors)

Leagues / membership (in `app/lib/server-fns/fantasy.ts`):
- `createLeague` · POST · `{name, season, config?}` · any signed-in user ·
  insert league (status `setup`, owner=actor, config=DEFAULT_CONFIG merged with
  input.config, slug = kebab(name)+'-'+6hex), insert owner into
  `fantasy_members` (role `owner`) · `{leagueId, slug}` · UNAUTHENTICATED.
- `getLeague` · GET · `{slug}` · public read (but hide invite tokens) ·
  returns league + members (corps identity, draft_position, quiz taken bool) +
  draft summary · NOT_FOUND.
- `listMyLeagues` · GET · `{}` · signed-in · leagues where actor is a member.
- `updateLeagueConfig` · POST · `{leagueId, config}` · owner only · validate +
  store; **reject changing draft-shape fields once draft.status != 'scheduled'**;
  `weights` editable until finals week · `{ok}` · FORBIDDEN/CONFLICT.
- `createInvite` · POST · `{leagueId, email?, maxUses?, expiresInDays?}` · owner ·
  insert invite (token = 32 random bytes base64url via
  `crypto.getRandomValues`), default maxUses 1, expires +14d; if email set, send
  invite email · `{token, url}` · FORBIDDEN.
- `revokeInvite` · POST · `{inviteId}` · owner · set `revoked_at` · `{ok}`.
- `acceptInvite` · POST · `{token, corpsName?, showTitle?, color?, logoMediaId?}` ·
  signed-in · the race-safe accept (Appendix G.3) · `{leagueId, slug, needsIdentity}`
  · NOT_FOUND/CONFLICT (used-up/expired/full/already-member/draft-started).
- `setCorpsIdentity` · POST ·
  `{leagueId, corpsName, showTitle, color, logoMediaId}` · member of league ·
  validate (corpsName non-empty, unique within league, ≤ 40 chars; color is
  `#rrggbb`), update member row · `{ok}` · FORBIDDEN/CONFLICT.
- `removeMember` · POST · `{leagueId, userId}` · owner, pre-draft only · set
  member status `removed` · `{ok}`.

Quiz:
- `getQuizForLeague` · GET · `{leagueId}` · member · if no in-progress attempt,
  create one (serve set per E.3, set started_at); return prompts+choices only
  (NO correct_index), plus remaining time · `{attemptId, questions[], endsAt}`.
- `submitQuiz` · POST · `{leagueId, answers:number[]}` · member · score per E.3,
  write attempt + member.quiz_score · `{weightedScore}` · CONFLICT(already done /
  expired).

Admin quiz (capability `manageFantasyQuiz`, see Appendix G.4):
- `adminListQuestions` / `adminUpsertQuestion` / `adminSetQuestionActive` ·
  POST/GET · question fields · require capability · audit each write.

Draft:
- `scheduleDraft` · POST · `{leagueId, scheduledAt}` · owner · upsert
  `fantasy_drafts` (status `scheduled`, draft_type+pick_seconds+total_rounds from
  config), enqueue reminder jobs (E/H), email members · `{ok}`.
- `startDraft` · POST · `{leagueId}` · owner (or any member after
  scheduledAt+grace) · resolve order (E.1), set status `live`, current_pick_no 0,
  current_user_id=order[0], pick_deadline_at=now+pick_seconds, register timer
  (Appendix H.3), broadcast · `{ok}` · CONFLICT(not all identities set / <2 members).
- `makePick` · POST · `{leagueId, corpsKey, caption}` · current picker only ·
  validate legality (E.2), insert pick, advance draft, broadcast · `{ok, pick}` ·
  FORBIDDEN(not your turn)/CONFLICT(illegal/taken)/expired.
- `pauseDraft` / `resumeDraft` · POST · `{leagueId}` · owner · freeze/restore
  `pick_deadline_at` + timer · `{ok}`.

All mutations on a league first load the league row and verify
`actor.userId` is owner or member as required; otherwise throw FORBIDDEN.

## Appendix G — Invite → Google → join flow (exact steps)

### G.1 Prereq: better-auth callback config (verify in M1)
`app/lib/auth.ts` sets `baseURL` from `BETTER_AUTH_URL`. The join route is
same-origin, so `signIn.social({ provider:'google', callbackURL:'/fantasy/join/<token>' })`
returns to our route. **Verify** `BETTER_AUTH_URL` is the real public origin in
prod (`https://drumcorps.app`). If better-auth rejects the callbackURL as
untrusted, add `trustedOrigins: [baseURL]` to the betterAuth config. No other
auth change is needed.

### G.2 Route `app/routes/fantasy/join/$token.tsx`
- **loader(token):** look up invite by token. Compute `state`: `invalid`
  (missing/revoked/expired), `used_up` (`used_count >= max_uses`), or `ok`. If
  `ok`, also return league name/owner/memberCount. Do not leak the token back in
  any other API.
- **render:**
  - state != ok → friendly message (Appendix-listed reasons), no CTA.
  - signed in (session present) → show corps-identity form (name/show/logo/
    color), submit → `acceptInvite` (with identity fields) → redirect to league.
  - signed out → "Continue with Google" button. On click:
    1. set cookie `fantasy_invite=<token>` (httpOnly, Secure in prod,
       SameSite=Lax, Path=/, Max-Age=1800) — via a tiny server route or by
       returning Set-Cookie from a server-fn.
    2. call `authClient.signIn.social({ provider:'google',
       callbackURL: '/fantasy/join/' + token })`.
  - On return, the loader now sees a session; the token comes from the URL param
    (preferred) or the `fantasy_invite` cookie (fallback if the param was lost).
    Proceed to the corps-identity form, then `acceptInvite`. Clear the cookie
    after a successful accept.

### G.3 `acceptInvite` race-safe body (exact SQL)
```sql
UPDATE fantasy_invites
   SET used_count = used_count + 1
 WHERE token = ?
   AND revoked_at IS NULL
   AND expires_at > ?            -- now ISO
   AND used_count < max_uses;
```
Check `rowsAffected === 1`. If 0 → throw CONFLICT (used-up/expired/revoked).
Then in the same logical step:
- load league; if `status NOT IN ('setup','quiz','scheduled')` → throw
  CONFLICT('draft-started'); if member count >= max_members → throw
  CONFLICT('full'); if actor already a member → return `{already:true}` (and
  decrement used_count back, since we didn't consume a seat).
- insert `fantasy_members` (role `member`, joined_at now). Return
  `{leagueId, slug, needsIdentity: corps_name IS NULL}`.

### G.4 New capabilities in `app/lib/authz.ts`
Add to the `Capability` union and `MIN_ROLE`:
- `manageFantasyQuiz: 'moderator'`
- `manageFantasyLeagues: 'admin'`
Then admin server-fns call `requireCapability(getWebRequest(), 'manageFantasyQuiz')`.

### G.5 Invite edge cases → exact responses (see §7.5 for the list)
Map each to the CONFLICT/NOT_FOUND messages above; the route renders a specific
sentence per case. Re-click by an existing member is a no-op redirect to the
league dashboard.

## Appendix H — Realtime draft (SSE) skeletons

### H.1 In-memory bus `app/lib/fantasy/bus.ts`
```ts
type Client = { id: string; send: (event: string, data: unknown) => void };
const rooms = new Map<string, Set<Client>>();           // leagueId -> clients
export function subscribe(leagueId: string, c: Client) {
  (rooms.get(leagueId) ?? rooms.set(leagueId, new Set()).get(leagueId)!).add(c);
  return () => rooms.get(leagueId)?.delete(c);
}
export function broadcast(leagueId: string, event: string, data: unknown) {
  for (const c of rooms.get(leagueId) ?? []) c.send(event, data);
}
```
DB is the source of truth; the bus is only fan-out. (Single-process assumption,
A8/V1.)

### H.2 SSE route `app/routes/api/fantasy/draft/$leagueId/stream.ts`
Return a `ReadableStream` with `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `Connection: keep-alive`. On open: verify the actor
is a league member (else 403); send one `snapshot` event with full draft state
(draft row + all picks + remaining pool); register the client on the bus;
heartbeat `:\n\n` every 25s; on cancel, unsubscribe. Each message is
`event: <name>\ndata: <json>\n\n`. Events: `snapshot`, `pick` (a new pick +
advanced draft state), `state` (pause/resume/complete). Support `Last-Event-ID`
by replaying picks with `pick_no >= lastId`.

### H.3 Auto-pick timer
`makePick`/`startDraft`/`resumeDraft` (re)arm a per-league `setTimeout` to fire
at `pick_deadline_at`. On fire, run `runAutoPickIfDue(leagueId)`: re-load draft
(abort if not `live` or deadline moved), choose the best legal pick by C.3
prior-season ranking among legal options (E.2), insert it (auto_picked=1),
advance, broadcast, re-arm. On process start, scan `fantasy_drafts` where
`status='live'` and re-arm timers (self-heal). Serialize all draft mutations per
league with a simple in-memory async lock keyed by leagueId so two picks can't
race; the U1 unique index is the backstop.

### H.4 Cron dispatch `app/routes/api/fantasy/jobs/dispatch.ts`
GET/POST guarded by header `x-fantasy-cron: <FANTASY_CRON_SECRET>` (404/401 if
mismatch). Selects `fantasy_scheduled_jobs WHERE done_at IS NULL AND due_at <= now`,
processes each (send email/notification, or finalize a season), sets `done_at`.
Idempotent. Add a system cron on the VM (Appendix A) hitting this every 2–5 min.

### H.5 Client
A `useEventSource(url)` hook (new, ~30 lines): open `EventSource`, parse named
events, expose latest snapshot+picks, reconnect with backoff using the last
`pick_no` as `Last-Event-ID`. The draft page renders board/pool/countdown/roster
and calls `makePick` server-fn on the user's turn (optimistic, reconciled by the
`pick` broadcast).

## Appendix I — Per-milestone task checklists + acceptance

Build in order. Each milestone is behind `VITE_ENABLE_FANTASY`. "Done" = its
acceptance check passes locally.

- **M0:** add Appendix B DDL to `contributions-db.ts`; create
  `app/lib/fantasy/{captions,config,scoring}.ts` (constants, valibot config
  schema + DEFAULT_CONFIG, pure scoring fns from Appendix D); refactor
  `sendMagicLink` into `app/lib/email.ts` `sendEmail({to,subject,html,tag})`;
  add `VITE_ENABLE_FANTASY` plumbing. **Accept:** `getContributionsDb()` creates
  all tables without error; unit tests for `computeRosterScore` match the two
  worked examples in Appendix D; config validation rejects a bad config.
- **M1:** server-fns createLeague/getLeague/listMyLeagues/createInvite/
  revokeInvite/acceptInvite/setCorpsIdentity (Appendix F.1); routes
  `fantasy/index`, `fantasy/create`, `fantasy/$slug/index`,
  `fantasy/join/$token` (Appendix G); invite email. **Accept:** user A creates a
  league, mints a link; user B opens the link signed-out, signs in with Google,
  lands back on the join route, sets corps identity, and appears in the league;
  all §7.5 edge cases return the right message.
- **M2:** authz capabilities (G.4); admin quiz CRUD routes; `getQuizForLeague`/
  `submitQuiz` (E.3); draft-order resolution (E.1). **Accept:** admin adds
  questions; member takes quiz once (no retake); correct_index never appears in
  any network payload (assert in a test); draft order matches E.1 for each
  `quizOrderDir` incl. ties and non-takers.
- **M3:** bus + SSE route + makePick + startDraft + pause/resume + auto-pick
  timer (Appendix H, E.2); draft UI. **Accept:** a 3-member draft completes with
  correct snake order, slot indexes, and weights; an expired clock auto-picks
  the top legal corps; killing and restarting the server mid-draft re-arms the
  timer and the draft continues; no duplicate `(corps,caption)` possible.
- **M4:** `sdk/src/fantasyStandings.ts` (Appendix C.5 + D), hook after
  `scrapeWebsiteRecapsForSeason` (~`sdk/src/websiteScraper.ts` L507); standings
  UI; cron dispatch (H.4) + scheduled reminder jobs; finals detection (§5.5).
  **Accept:** running the recompute against a frozen 2026-shaped fixture writes
  `fantasy_standings` matching hand-computed values; re-running is idempotent;
  passing the finals date flips `is_final` and league `status='complete'`.
- **M5 / M6:** push / payments — later, per §8.2 / §12.
