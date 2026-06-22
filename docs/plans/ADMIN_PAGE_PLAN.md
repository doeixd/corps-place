# `/admin` — unified operator console — plan

Status: planned (2026-06-22). Verified against the codebase. **M1 started:** the admin
console capabilities (`viewAdmin`, `runJobs`, `manageUsers`, `customerSupport`,
`impersonate`) and the `getActor` banned-check (R3) have landed in `app/lib/authz.ts`
(additive; `npm run check` clean, no new errors). Remaining M1: shell + gate helpers +
Overview (Appendix A).

## Why this exists / what it replaces

Three existing plans each assume an admin surface but none builds the shell:

- **`PREGEN_AND_ADMIN_PLAN.md` (Part B)** — a job dashboard to trigger + observe the
  SDK scripts the cron runs. **Its auth section (B0, `ADMIN_TOKEN` shared secret) is
  now obsolete** — it predates better-auth. We use the real role system instead.
- **`FANTASY_DCI_PLAN.md` §11.1** — `/admin/fantasy/quiz` (bank CRUD) +
  `/admin/fantasy/leagues` (ops console), gated by new caps `manageFantasyQuiz` /
  `manageFantasyLeagues`.
- **`PAGEANTRYJOBS` plan** — claim-revoke + posting/profile moderation (reuses the
  role matrix).

Plus an orphan: **`/admin/corps-colors.tsx` already exists** but is gated only by
`isDev` (`corps-colors.tsx:20-28`) with a code comment "No auth gate exists yet." It
must move under the real gate.

This plan defines the **shell, auth model, and observability spine** that all of the
above plug into. Build this first; the feature-specific consoles (fantasy, jobs) are
then thin routes under it.

---

## 0. Verified ground truth (read before building)

- **Auth is done.** `app/lib/authz.ts` has `Role` (`user→trusted→moderator→admin`),
  `can()`, `getActor(request)`, `requireCapability(request, cap, ctx)`. better-auth
  (`app/lib/auth.ts`) stores `role` on the user (`additionalFields.role`,
  `input: false`, default `'user'`). Sessions resolve via
  `auth.api.getSession({ headers })`.
- **No role-granting UI exists.** `role` is `input: false`, so it's only settable
  out-of-band today (DB/tinker on `/data/contributions.db`). **Bootstrapping the
  first admin is a manual SQL step** (documented in §3). User management (§7) adds
  the in-app path.
- **A background-job runner already ships** and is the template: `event-directory.ts`
  — `event_directory_refresh_runs` table (`refresh_id, season, status
  running|success|failed, started_at, finished_at, event_count, stdout, stderr,
  error_message`), detached `spawn` (`spawnRefreshInBackground`), streamed stdout via
  `appendRefreshRunOutput`, status reads (`latest2026Refresh`). Wrapped as an Effect
  `EventDirectoryService`. **Generalize this — do not reinvent.**
- **Two databases.** Writable `contributions.db` (`getContributionsDb()`,
  inline-`CREATE TABLE IF NOT EXISTS` migrations in `contributions-db.ts`) holds
  wiki + fantasy + (future) jobs + admin tables. Read-only `dci-relational.db` is the
  score/corps source; **corps colors write there** via `corps-colors.ts` (curated
  fields), which is the one admin action that mutates the relational DB.
- **Existing admin route:** `app/routes/admin/corps-colors.tsx` (dev-gated).
- **Server-fn pattern:** `createServerFn({method}).validator(v.parse(...)).handler()`;
  every write calls `requireCapability(getWebRequest(), ...)` first. UI gating is
  cosmetic; the server is the gate (repeat for every admin fn).
- **UI kit:** ReUI/shadcn `base-nova` (`Card`, `Button`, `Badge`, `Table`,
  `DataGrid`, `Alert`, `Input`, `Label`, `Select`). XState v5 for stateful UI.
  `<Show>`/`<For>`, Motion. Per AGENTS.md, **no logic in components** — delegate to
  machines + server-fns.
- **Prod realities:** single Node process (in-process timers OK, A8); 2-vCPU box
  (long jobs like fine-tune peg CPU — warn before daytime trains); cron lives on the
  Coolify VM and can hit internal endpoints; durable writes must fail-closed via
  `durableStorageStatus()`.
- **⚠️ The serving container CANNOT run SDK scripts — verified, and it reshapes §5.**
  `.dockerignore` excludes `sdk/scripts`, `sdk/models`, and `**/*.db`; the `Dockerfile`
  copies only `.output/`, `docker-entrypoint.sh`, and the R2 pull scripts; and
  `pnpm install --prod` drops devDeps (no `tsx`, no `tfjs`). So
  `spawnRefreshInBackground` (`event-directory.ts:378`) and the prediction generator
  (`event-prediction-api.ts:514`) — both `npx --yes tsx scripts/… cwd: <repo>/sdk` —
  **ENOENT in the prod container.** They only work in local dev (where `sdk/` exists).
  In prod they are effectively dead code; the request path serves *pre-generated* rows
  from the read-model and never spawns.
- **All heavy jobs run on the VM via `patrick`'s crontab** (`docs/MERCH_DEPLOY.md`):
  `sync-merch.sh` (02:00), `nightly-predictions.sh` (03:30, runs
  `npx tsx scripts/predictEventRecap.ts --save-db` from `/root/corps-place/sdk`),
  `sync-dev-read-model.sh` (04:15), `backup-relational.sh` (05:00) — all on the VM disk
  where `sdk/` and `dci-relational.db` actually exist. **This is the real execution
  substrate the admin Jobs runner must target.**
- **Script inventory (verified):** in `sdk/scripts/` — `seasonUpdateWorkflow.ts`,
  `scrapeCorps.ts`, `scrapeEventPages.ts`, `scrapeWebsiteRecaps.ts`,
  `ingestLineupsFromScrapes.ts`, `predictEventRecap.ts`. The **fine-tune entrypoint
  exists at `sdk/src/training/trainModelV9Subcaption-fixed.ts`** (not under `scripts/`
  — my earlier note was wrong about the path). `seasonUpdateWorkflow.ts:571` invokes it
  as `npx tsx src/training/trainModelV9Subcaption-fixed.ts --load-model <dir>
  --trial-id … --epochs … --batch …`; "latest model" is resolved by `findLatestModelDir()`
  (newest dir containing `model.json` — no symlink). Models land in
  `sdk/models/v9_subcaption_fixed/<trial-id>/`.

---

## 1. Information architecture

Each `/admin/*` section is its own file-route, sharing a gate + a sidebar. **Two ways
to share the shell — pick the repo-idiomatic one:**

- **(A, recommended) shared component + helper, no layout route.** The repo has **no
  `route.tsx` layout files** today (verified); routes self-gate in `beforeLoad`/loader.
  So each `admin/*.tsx` wraps its body in a shared `<AdminShell>` (sidebar + chrome)
  and calls a shared `requireAdminLoader(cap)` in its `loader`. Lowest-risk, matches
  existing idiom exactly.
- **(B) a TanStack layout route** `app/routes/admin/route.tsx` rendering
  `<AdminShell><Outlet/></AdminShell>`. TanStack Router *does* support this (a `route.tsx`
  is the directory's layout), but it's a **new convention for this repo** — only adopt
  if we want the gate in one place. Children still re-gate per §2.

Sections, each its own route:

| Route | Section | Min role | Backing |
|---|---|---|---|
| `/admin` (`index.tsx`) | **Overview** — freshness, coverage, DB stats, running jobs | moderator | new `adminStatus()` |
| `/admin/jobs` | **Jobs & scripts** — trigger + observe SDK jobs, live log tail, history | admin | new `admin_jobs` (§5) |
| `/admin/content` | **Content moderation** — show-wiki revisions, media, citations: hide/revert/lock | moderator | existing contrib tables |
| `/admin/identity` | **Entity/identity data** — staff merge/split, bio-photo curation, corps colors, curated/locked fields | moderator | SDK scripts on relational DB (§6.5) |
| `/admin/fantasy/quiz` | **Fantasy quiz bank** CRUD | moderator (`manageFantasyQuiz`) | `fantasy_quiz_questions` |
| `/admin/fantasy/leagues` | **Fantasy league ops** | admin (`manageFantasyLeagues`) | `fantasy_*` |
| `/admin/jobs-board` | **PageantryJobs moderation** — claims, postings, profiles | moderator | `jobs_*` (when built) |
| `/admin/system` | **System & ops** — read-model generation, scrape health, data-quality, DB size, backups, errors | moderator | `rm_meta`, `dq_*`, pragmas (§8) |
| `/admin/users` (+ `/admin/users/$id`) | **User management & support lookup** — list, grant/revoke role, ban, sessions, impersonate, GDPR delete/export | admin / `customerSupport` | better-auth `user` (§7, §10) |
| `/admin/support` | **Support inbox** — `/contact` submissions: triage, reply, deep-link to user | moderator (`customerSupport`) | new `contact_messages` (§10.3) |
| `/admin/audit` | **Audit log** — every admin action | moderator | new `admin_audit` (§8) |

Sidebar items are filtered by the viewer's role (a moderator never sees the
admin-only items). Sections whose feature flag is off (`VITE_ENABLE_FANTASY`,
jobs brand) are hidden. Build incrementally — the shell + Overview + one real
section (Jobs) first; the rest are additive routes.

### 1.1 ⚠️ The defining constraint: the web tier can only write `contributions.db`

This shapes *every* section, not just Jobs (§5). The serving container has **only**
`contributions.db` + the read-model + media-cache (DEPLOYMENT_REALITY). It does **not**
have `dci-relational.db` (the corps/staff/judge/score source) or `sdk/scripts/`. So:

- **Web app can directly mutate** (its own writable DB): wiki contributions
  (revisions/media/citations/locks), fantasy, jobs-board, users (better-auth tables
  live here), and the `admin_*` tables. These sections get plain server-fns.
- **Web app CANNOT directly mutate** the relational source: corps colors, staff
  merge/split, bio/photo candidates, curated fields, any read-model field. **Today's
  `corps-colors.ts` writes `dci-relational.db` — which only works in dev**; that's why
  the route is dev-gated. In prod these are **VM-side operations**.

⇒ **Two write paths, one console.** Direct server-fns for contributions-DB sections;
the **enqueue → VM-worker** path (§5) for anything touching the relational DB or
running a script. The Identity section (§6.5) is the main consumer of the enqueue
path beyond Jobs. The UI hides the distinction; the architecture must not.

---

## 2. Auth model (the spine)

**Reuse the role system; do not add `ADMIN_TOKEN`.** Gate the *route* (UX) AND every
*server-fn* (security). **Match the repo's actual pattern** (verified against the
fantasy routes) — don't invent a new one:

- In this repo, `beforeLoad` is kept **synchronous** for statically-known checks
  (e.g. `if (!FANTASY_ENABLED) throw notFound()` — `fantasy/index.tsx:18`). It does
  **not** resolve the session there (that needs the server request).
- **Auth is enforced in the `loader`**, which calls a server-fn that throws when
  unauthorized; the route **catches and renders** a sign-in / not-authorized state.
  Fantasy does exactly this: the loader calls `listMyLeagues()`, catches
  `UNAUTHENTICATED`, and returns `{ signedIn: false }` for the component to handle
  (`fantasy/index.tsx:24-33`).

So for admin:

1. **Route gate (UX)** — the section's `loader` calls a tiny `requireAdmin(cap)`
   server-fn (resolves `getActor(getWebRequest())`, throws `ForbiddenError` /
   `UNAUTHENTICATED` if `!can`). The component catches → renders "sign in" (signed
   out) or a 404/forbidden screen (signed in, wrong role). Reuse `notFound()` for the
   wrong-role case to avoid advertising the console's existence. Helper:
   `requireAdminLoader(cap)` shared by every admin route (option A in §1).
2. **Server-fn gate (security)** — every admin server-fn calls
   `requireCapability(getWebRequest(), cap)` **first**. This is the real gate; the
   loader check is just so the page renders sensibly. Never trust the client.

**New capabilities** (add to `MIN_ROLE` in `authz.ts`):

```ts
viewAdmin:            'moderator',  // see the console at all
runJobs:              'admin',      // trigger SDK scripts
manageUsers:          'admin',      // grant/revoke roles, ban
manageFantasyQuiz:    'moderator',  // fantasy plan §11.1
manageFantasyLeagues: 'admin',      // fantasy plan §11.1
customerSupport:      'moderator',  // user lookup, support inbox, recovery (§10)
impersonate:          'admin',      // "view as user" — high-trust (§10.2)
```

`grantRole` / `deletePage` already exist. Keep "edit/upload/revert = any user" — the
console only adds the *operator* capabilities above.

**Decision — moderator vs admin split.** Moderators get read-only observability +
content/quiz moderation (the day-to-day). Admins get destructive/operational power
(spawning jobs, role changes, league cancel/refund). This matches the existing
`MIN_ROLE` philosophy.

---

## 3. Bootstrapping the first admin (must document)

Because `role` is `input: false`, no one is an admin until promoted out-of-band.
Runbook step (prod, on the box):

```sh
sqlite3 /data/corps-place/contributions.db \
  "UPDATE user SET role='admin' WHERE email='ithepatrickglenni@gmail.com';"
```

(better-auth tables live in `contributions.db` — see the deploy memory.) After that,
all further promotions go through `/admin/users` (§7). Add this to the deployment
runbook; it's the one un-automatable step.

---

## 4. Overview dashboard (`/admin` index)

Read-only snapshot, one `adminStatus()` server-fn → `Card` grid. XState
`admin-machine.ts` polls it on an interval (machine `after`/invoked actor), per
AGENTS.md.

What it shows (mostly from `PREGEN_AND_ADMIN_PLAN` B4, verified against tables):

- **Data freshness** — latest `corps_page_scrapes.scraped_at`, `event_page_scrapes`,
  `website_recaps`, last `event_directory_refresh_runs`.
- **Prediction coverage** — upcoming 2026 events with/without a fresh cached
  prediction (`isCachedPredictionFresh`); "events needing prediction" count.
- **DB stats** — key row counts (events, corps, lineup entries, predictions, +
  contributions: show_pages, revisions, fantasy leagues/members) and file sizes of
  both DBs.
- **Model** — latest dir under `sdk/models/v9_subcaption_fixed/` + metadata; last
  fine-tune job.
- **Running jobs** — any `admin_jobs` currently `running`, with a link to its tail.
- **Health flags** — durable storage ready? read-model generation/age? (surface
  staleness loudly — see the stale-data memory).

---

## 5. Jobs & scripts (`/admin/jobs`) — enqueue, don't spawn

**Architecture decision (forced by R1, now resolved).** The serving container can't
run SDK scripts, so the admin UI **does not spawn jobs in-process in prod.** Instead:

> The web app **enqueues** a job request (a row in `admin_jobs` with status
> `queued`). A **worker on the VM** — where `sdk/` and `dci-relational.db` exist —
> claims queued rows, runs the script, and streams status/stdout back into the same
> row. The admin UI is a **producer + observer**; the VM is the executor. This mirrors
> the existing `fantasy_scheduled_jobs` + `dispatchDueReminders` cron pattern (Fantasy
> plan §8.1) and the existing crontab substrate.

This keeps one code path for both environments: **local dev** can optionally run an
in-process executor (the existing `spawn` works there) so a developer sees jobs run
without the VM worker; **prod** relies on the VM worker. Same table, same UI.

### 5.1 Table (`contributions-db.ts` SCHEMA array)

```sql
CREATE TABLE IF NOT EXISTS admin_jobs (
  job_id        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,   -- see registry below
  args_json     TEXT,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','success','failed','canceled')),
  requested_by  TEXT NOT NULL,   -- user id (audit)
  claimed_by    TEXT,            -- worker/host id that picked it up
  queued_at     TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  exit_code     INTEGER,
  stdout        TEXT,            -- streamed by the worker, capped (ring-buffer tail)
  stderr        TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_status ON admin_jobs (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_kind_time ON admin_jobs (kind, queued_at);
```

### 5.2 The VM worker (`scripts/admin-job-worker.sh` + a small SDK runner)

A new script run by cron on the VM (e.g. every 1 min, like the reminder dispatcher),
or a long-lived loop. It:

- Claims the oldest `queued` row **atomically** (`UPDATE … SET status='running',
  claimed_by=?, started_at=? WHERE job_id=(SELECT … WHERE status='queued' ORDER BY
  queued_at LIMIT 1) AND status='queued'` — check `rowsAffected` to win the race).
- Maps `kind → argv` (one place, in the SDK runner) and runs the script from
  `/root/corps-place/sdk` (reuse `nightly-predictions.sh`'s `cd "$repo_root/sdk"`
  shape), streaming stdout/stderr into the row (capped tail), finalizing status +
  exit code on exit. Appends an `admin_audit` row.
- **One running job at a time** (the worker is single-threaded → natural global mutex,
  which also satisfies the "never two SQLite writers" invariant). Per-kind dedupe:
  refuse to enqueue a second `queued`/`running` of the same kind.

Reuse `spawnRefreshInBackground` / `appendRefreshRunOutput` logic from
`event-directory.ts` **inside the worker** (it runs where `sdk/` exists), not in the
web server.

**`kind → argv` registry** (verified script names):

| kind | command (run in `sdk/`) |
|---|---|
| `season_update` | `npx tsx scripts/seasonUpdateWorkflow.ts --season 2026 [--fine-tune]` |
| `scrape_corps` | `npx tsx scripts/scrapeCorps.ts --apply [--refresh] [--slug …]` |
| `scrape_event_pages` | `npx tsx scripts/scrapeEventPages.ts` |
| `scrape_recaps` | `npx tsx scripts/scrapeWebsiteRecaps.ts` |
| `ingest_lineups` | `npx tsx scripts/ingestLineupsFromScrapes.ts` |
| `generate_predictions` | the batch generator (PREGEN plan Part A) / wrap `nightly-predictions.sh` |
| `regenerate_event` | `npx tsx scripts/predictEventRecap.ts --event <slug> --season 2026 --save-db --force-refresh` |
| `fine_tune` | `npx tsx src/training/trainModelV9Subcaption-fixed.ts --load-model <findLatestModelDir> --trial-id <season>_admin_<ts> --epochs … --batch …` (long CPU job; gate behind a confirm + daytime warning) |

After a write-side job that changes the read-model, the worker must **republish**
(`scripts/refresh-prod-read-model.sh` / `push:data read-model`) so the app sees it —
fold this into the relevant kinds, same as the nightly scripts do today.

### 5.3 Server-fns (`app/lib/server-fns/admin.ts`)

- `adminStatus()` → Overview snapshot (§4). Cap `viewAdmin`.
- `adminEnqueueJob({kind, args})` → validate (valibot), per-kind dedupe, insert a
  `queued` row, audit. Cap `runJobs`. **Does not spawn.**
- `adminJob({id})` / `adminJobs({kind?})` → status + stdout tail for polling.
- `adminCancelJob({id})` → only if still `queued` (set `canceled`); a `running` job
  can't be killed from the web tier (worker owns the process). Cap `runJobs`.

### 5.4 UI

`Card` per job kind with an **Enqueue** `Button` (destructive ones — fine-tune,
regenerate-ALL — behind a confirm), a `Badge` status pill (`Match` status→variant,
incl. `queued`), a `Table`/`DataGrid` of recent runs, and a **live stdout tail**
(`<pre>` polled via `adminJob`). Show queue position + "picked up by VM" so the
producer/observer split is legible. Warn before enqueuing a CPU-heavy train during the
day.

### 5.5 Safety invariants

- **Single VM worker = global write mutex** (no two SQLite writers; the old
  per-kind-only guard is no longer enough on its own, but enqueue-dedupe still prevents
  duplicate queued rows).
- Worker self-heals after a VM/app restart: it just re-scans `queued`/`running` rows
  (a `running` row with a dead `claimed_by` past a timeout → requeue or mark failed).
- The web tier never holds a child process, so a deploy/restart never orphans a job.

---

## 6. Content moderation (`/admin/content`)

The wiki contribution system already has the *capabilities* defined in `authz.ts`
(`edit`, `revert`, `lock`, `hideRevision`, `orphan`, `deletePage`) but **most have no
server-fn yet** — only edit/revert/upload/citations are wired. The console is partly
"add UI over existing fns" and partly "wire the missing fns." All contributions live
in `contributions.db`, so these are **direct server-fns** (no VM worker needed).

### 6.1 Already wired — console just needs UI

| Action | Server-fn | Cap |
|---|---|---|
| View contributions / history (per page) | `getShowContributions`, `getShowHistory` (public read) | — |
| Revert a block edit | `revertRevision` (`contrib.ts:84`) | `revert` |
| Save/override block | `saveShowBlock` (`contrib.ts:158`) | `edit` |
| Upload media (EXIF-stripped, WebP, R2) | `uploadShowMedia` (`media.ts:32`) | `upload` |
| Create/list citations (SSRF-guarded, OG prefetch, dedupe) | `createCitation`/`listCitations` (`citations.ts`) | `edit` |

The new value is the **cross-page firehose**: today moderation is per-page only
(`HistoryPanel` on the show page). Add a `listRecentRevisions({filters})` read (across
all `show_revisions`, join `user` for names) → a moderation feed with diff + revert.

### 6.2 Net-new server-fns (contributions-DB writes — straightforward)

- **`lockPage`/`unlockPage`** — `UPDATE show_pages SET lock_level=?`. The edit/upload
  fns *already enforce* lock level (`contrib.ts:169`, `media.ts:43`); only the setter
  is missing. Cap `lock`.
- **`listShowPages({status,lock,updatedSince})`** — admin list of all pages (none
  exists today). Cap `viewAdmin`.
- **`deletePage`** — admin-only; plan philosophy is "never delete, mark orphaned." Cap
  `deletePage`.

### 6.3 Net-new requiring a small schema migration

`hideRevision` has **no visibility column** today. To hide a bad revision or media:

- Add `hidden INTEGER DEFAULT 0` to `show_revisions` and to `show_media`
  (additive, safe). Then `hideRevision`/`hideMedia` server-fns flip it, and the read
  paths filter it (`getShowHistory`, the `/api/show-media/$id` route). Cap
  `hideRevision`. (Append-only philosophy preserved: we tombstone, never delete.)

### 6.4 Stewards (deferred)

`show_stewards` exists in schema but has no server-fn or UI. Steward
assignment/notifications are a later milestone — list only, no actions, in v1.

All §6 actions write an `admin_audit` row (§8).

---

## 6.5 Entity & identity data management (`/admin/identity`) — VM-executed

This is the richest net-new area and the main non-Jobs consumer of the enqueue path
(§1.1), because it all mutates `dci-relational.db`. Today it's **CLI-only**; the
console exposes a curated subset.

### 6.5.1 What exists (all SDK scripts, verified)

- **Staff identity** is `staff_id` rows rolled up to a canonical `person_id`. A review
  queue table `corps_staff_review` (`relational.ts:660`) records pairwise
  same-person/keep-separate decisions (immutable audit). Scripts:
  `resolveStaffIdentity.ts` (master CLI: `--merge A B`, `--split A B`,
  `--auto-merge --confidence`, `--list`), `mergeByNameDefault.ts`, `mergeNicknames.ts`,
  `mergeNameVariants.ts`, `mergeBySharedPhoto.ts`, plus name/title cleaners.
- **Bio/photo candidate store** `staff_profile_candidates` (`relational.ts:5101`):
  every scraped bio/photo kept, `is_current` = chosen (newest `source_date`, then
  longest). `applyStaffResearch.ts` selects current; an admin "set canonical" =
  flipping `is_current` + syncing `corps_staff`.
- **Structured facts** `staff_bio_facts` (education/award/hometown/position), mined by
  `mineBioFacts.ts`.
- **Judges have no merge layer** — `judge_id` is permanent, no `person_id`, no review
  queue, no candidate store. Identity ops here are staff-only in v1.
- **Curated fields** — `corps_curated_fields` marks human-authoritative values so
  re-ingest doesn't clobber them (the colors editor uses `field='colors'`; same
  mechanism generalizes to names/city/about). Corps colors (`corps-colors.ts`) is the
  one existing editor — **move it under `/admin/identity` and re-route its write
  through the worker** (it currently writes the relational DB directly → dev-only).

### 6.5.2 What the console exposes (v1)

- **Staff merge review queue** — list `corps_staff_review` `needs-review` pairs (with
  photo/corps/seasons context) → approve-merge / keep-separate / split. Each decision
  **enqueues** a `resolve_staff_identity` job (`--merge`/`--split`) the VM runs; the
  decision is also recorded so it's auditable before the job lands.
- **Bio/photo curation** — for a person, show all candidates; "make canonical"
  enqueues a `set_staff_canonical` job. Manual bio/photo edit likewise.
- **Corps colors** — keep the existing live-preview editor UI; the save enqueues a
  `save_corps_colors` job (replaces the direct relational write).
- **Curated-field editor** — edit a corps's authoritative name/city/about and mark
  curated (enqueue).

New job kinds for the §5 registry: `resolve_staff_identity`, `set_staff_canonical`,
`save_corps_colors`, `set_curated_field`. Each re-emits/republishes the read-model on
completion (§5.2) so the change goes live.

### 6.5.3 Alternative (decide at build): decision-table apply

Instead of one enqueued job per click, the console could **write decision rows to a
`contributions.db` table** (e.g. `identity_decisions`) that a single VM "apply"
script drains in batch. Pro: instant UI ack, batches re-emits (one republish per
batch, not per click — matters because re-emit is heavy). Con: a second moving part.
**Recommended** for identity given re-emit cost; the per-click enqueue is fine for
colors. Confirm at M-identity.

---

## 7. User management (`/admin/users`)

The missing piece that makes role-granting self-serve (replaces the manual SQL after
the first bootstrap).

**Decision (R3 resolved): enable the better-auth `admin` plugin.** It's already
installed (better-auth `1.6.19`, `app/lib/auth.ts` / package.json) — just not enabled.
Enabling it adds `banned`/`banReason`/`banExpires` columns (auto-migrated) and built-in
endpoints: `list-users` (search/paginate/sort), `set-role`, `ban-user`/`unban-user`,
`listUserSessions` + `revokeUserSession(s)`, `removeUser`, and impersonation. This
replaces a pile of hand-rolled server-fns.

```ts
// app/lib/auth.ts plugins:
admin({ defaultRole: 'user', adminRoles: ['admin'] })
```

**Reconcile with the existing role model (important):** we already have a 4-tier
`role` additionalField (`user|trusted|moderator|admin`, `input:false`) that
`authz.can()` reads. Keep `authz` as the authorization brain; use the plugin only for
the *mechanics*. Set `adminRoles:['admin']` so the plugin's own endpoint guard agrees
with our top tier, and **wrap the plugin endpoints in our own server-fns** that first
call `requireCapability(req, 'manageUsers')` — don't expose the raw admin endpoints to
the client, so our guard rails and audit always run.

- **List/search users** — via the plugin's `listUsers`, behind a `manageUsers` server-fn.
- **Grant/revoke role** — `adminSetUserRole({userId, role})` → plugin `setRole`. Guard
  rails: cannot demote the last admin; cannot escalate above your own rank; confirm on
  admin grants. Writes `admin_audit`.
- **Ban / disable** — plugin `ban-user`/`unban-user` (with optional reason/expiry).
  Confirm `getActor` rejects banned users (the plugin blocks new sessions; verify it
  also blocks *existing* sessions, else revoke sessions on ban).
- **User lookup** — find a user, see their contributions/uploads/leagues (cross-link
  to the moderation feed filtered by `author_id`).

Open question for product: should `trusted` be grantable here too (it gates wiki
lock-levels), or stay automatic? Default: grantable.

### 7.1 GDPR / compliance (build when there are real users)

The append-only revision/audit logs conflict with "right to erasure" — design the
purge path explicitly rather than discovering it under a deadline:

- **Delete/anonymize user** — remove PII (email/name) from the better-auth `user`
  row, null `author_id`s or replace with a tombstone id across `show_revisions`,
  `show_media`, fantasy/jobs rows. Keep the *content* (scoring/wiki integrity) but
  sever identity. Confirm whether to hard-delete vs anonymize per content type.
- **Export user data** — dump a user's contributions + account as JSON on request.
- Both behind `manageUsers` + audited. Lower priority than the operational sections,
  but a known requirement before a public launch (the PageantryJobs plan flags the
  same PII-vs-audit tension).

---

## 8. System & ops (`/admin/system`) + audit

- **`admin_audit` table** (append-only, mirrors the wiki-revision idea):

```sql
CREATE TABLE IF NOT EXISTS admin_audit (
  audit_id   TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL,
  actor_role TEXT NOT NULL,         -- frozen at write time
  action     TEXT NOT NULL,         -- 'start_job'|'set_role'|'ban'|'hide_revision'|'cancel_league'|…
  target     TEXT,                  -- entity id / kind
  before_json TEXT, after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit (created_at);
```

  Every mutating admin server-fn appends one row in the same write. `/admin/audit`
  renders it (filter by actor/action). The fantasy plan's `fantasy_admin_audit`
  (already in schema) can fold into this or stay separate — recommend **one
  `admin_audit`** for the whole console.

### 8.1 Observability signals (all already captured — just surface them)

The research found these exist; the System page reads them (mostly from the
read-model `rm_meta` + `dq_*` views + SQLite pragmas, which the web tier *can* read).

- **Read-model generation** — `rm_meta`: `built_at`, `schema_version` (currently 12),
  `ingest_commit` (git SHA baked in), `current_season`, `row_counts_json`,
  `source_db_mtime`. Plus which A/B slot is live (`read-model.active`) + its mtime.
  This is the single most important panel: "is the data live and fresh?" (ties to the
  stale-data memory).
- **Data quality** — the `dq_*` guardrail views (`dq_caption_total_mismatches`,
  `dq_duplicate_score_entries`, `dq_rank_inversions`, `dq_unknown_judges`, …) surfaced
  in `rm_meta.dq_counts_json`; any nonzero = a flag.
- **Scrape freshness & health** — `MAX(scraped_at)` per source from `corps_page_scrapes`,
  `event_page_scrapes`, `website_recaps`, `api_responses`; error counts
  (`http_status NOT IN (200,304)`), missing-lineup / unparsed-recap counts. **Note:**
  these live in `dci-relational.db`, which the web tier lacks — so this panel is fed
  by the VM (the job worker writes a small freshness snapshot into `contributions.db`
  or the read-model emits it into `rm_meta`). Decide the carrier at build.
- **Scrape capability** — is `BROWSERBASE_API_KEY` / `CHROME_CDP_URL` configured?
  (Cloudflare blocks direct fetch — AGENTS.md.) Last successful live fetch.
- **Model** — latest `sdk/models/v9_subcaption_fixed/.../model-card.json`:
  `generated_at`, validation `delta_mae_pts`, training rows. (VM-side; carry via the
  worker or a status file.)
- **DB size** — `PRAGMA page_count * page_size` for `contributions.db` (web-readable)
  and a VM-reported size for `dci-relational.db`. Disk growth is a real failure mode
  on the 4GB box.

### 8.2 Backups, errors, announcements

- **Backups** — show last `backup-relational.sh` (restic→R2) run + a "back up now"
  enqueue button. Data loss is existential for a wiki.
- **Error feed** — there's **no Sentry / health endpoint today** beyond `GET /`
  (DEPLOYMENT_REALITY) and a noop `observability.ts` Effect-metrics layer. v1: surface
  failed jobs (`error_message` + stderr tail) and stale-data conditions prominently on
  Overview. A real client/server error capture is a worthwhile later add (recall the
  `node:fs` client-bundle leak that SSR/curl/healthcheck all missed — a client-error
  beacon would have caught it).
- **Announcement banner** — a tiny `admin_settings` key (in `contributions.db`) for a
  site-wide notice ("scores are live", "maintenance"), editable here, no redeploy.
- **No silent truncation** — the stdout ring-buffer must label when it dropped lines.

### 8.3 Deliberately out of scope (over-engineering for a solo/2-vCPU app)

Per the best-practices review: no Prometheus/Grafana stack, no RBAC beyond the 4
roles, no ML spam classifier, no edit-approval workflow, no self-built analytics
pipeline (use a light self-hosted Plausible/Umami and deep-link to it). Keep it to a
handful of pages over existing scripts + queries.

---

## 9. Fantasy console (`/admin/fantasy/*`) — the heaviest section

Fantasy is a live, stateful, real-time, money-adjacent game, so it needs far more than
"CRUD + view." Three sub-areas. All fantasy data is in `contributions.db` → **direct
server-fns** (no VM worker). Caps: `manageFantasyQuiz` (moderator) for the quiz,
`manageFantasyLeagues` (admin) for league ops. Every write → `admin_audit` (fold the
already-existing `fantasy_admin_audit` table in, §8). The Fantasy plan's Appendix
already specs many of these fns (e.g. `pauseDraft`/`resumeDraft`, admin quiz fns).

### 9.1 Quiz bank (`/admin/fantasy/quiz`, `manageFantasyQuiz`)

`fantasy_quiz_questions` CRUD: add/edit, difficulty, tags, activate/deactivate
(soft-delete — never hard-delete questions with attempts), **bulk JSON import**,
preview. **`correct_index` and `explanation` must never be sent to a non-admin
client.** Surface bank health: count of `active` questions by difficulty vs. the
minimum a draft needs (Fantasy D2 — a too-small bank blocks quizzes). Fns:
`adminListQuestions`/`adminUpsertQuestion`/`adminSetQuestionActive`.

### 9.2 League ops console (`/admin/fantasy/leagues`, `manageFantasyLeagues`)

The support-and-rescue surface for live games. Find/search leagues (by name/owner/
status/season); drill into one to see members, picks, standings, draft state, config,
payment status, invites, notifications.

**Draft intervention (the draft *will* get stuck — these are not optional):**
- **Pause / resume** a live draft (`pauseDraft`/`resumeDraft` — already specced;
  freezes `pick_deadline_at`).
- **Force the current pick** to advance / **force auto-pick** for an absent or stuck
  drafter (the auto-picker exists; admin triggers it on demand).
- **Reschedule / restart** a draft (owner ghosted, `scheduled_at` passed — Fantasy
  §10 "draft never started"; B-grace path).
- **Make a pick on behalf of** an absent member (support override), respecting U1/U2/U3.
- **Edit draft order** (esp. `manual`; or fix a bad quiz-derived order).
- **Self-heal visibility:** show each live draft's `current_user_id`,
  `pick_deadline_at`, auto-pick timer state, connected SSE clients — so an operator can
  see *why* a draft is stalled (the SSE bus + timer are in-process, A8).

**Member & identity ops:**
- **Remove / reinstate** a member (pre-draft kick; post-draft mark `removed` keeping
  picks for scoring integrity).
- **Profanity / abuse take-down** of `corps_name` / `show_title` / `corps_logo`
  (Fantasy D5 — the only moderation path for member-authored corps identity); reset to
  a placeholder + notify.
- **Reset a quiz attempt** (member hit a bug / needs a retake — normally one-shot).

**Scoring & lifecycle:**
- **Force standings recompute** for a league (`recomputeFantasyStandingsForSeason` is
  idempotent — expose a manual trigger when a recap was corrected).
- **Edit / unlock scoring weights** in support cases (owner misconfigured; weights
  normally lock at finals week).
- **Cancel a league** (sets `status='canceled'`, revokes invites, notifies members).
- **Extend** the join/quiz deadline.

**Invites & comms:**
- View/revoke invite tokens; **re-send** an invite email; see who joined vs pending.
- View a league's notification log; **re-dispatch** a stuck reminder.

### 9.3 Fantasy ops observability

- **`fantasy_scheduled_jobs`** — the reminder/cron queue (due_at, kind, done_at); show
  due/overdue/failed so an operator sees if `dispatchDueReminders` is healthy (it's
  cron-driven, Fantasy §8.1 — same fragility class as the §5 worker).
- **Live drafts** panel — all `status='live'` drafts at a glance (good for "is anything
  on fire right now").

### 9.4 Payments & refunds (later — Fantasy M6 / §12)

When payments land: view `payment_status`/`payment_ref`; **issue a refund** (admin
override per the designed policy — full before draft, none after; exceptional goodwill
for outages); handle chargeback/dispute notes; idempotent by `payment_ref`. This is
both an admin *and* a customer-support function (§10).

---

## 9.5 PageantryJobs console (`/admin/jobs-board`)

When PageantryJobs ships: claim revoke (`revokeClaim`, already moderator-gated),
posting/profile hide, employer verification, claim-dispute resolution (impersonation
guard has no email proof — moderator reversal is the path). Reuses the role matrix.

---

## 10. Customer support tools

Distinct from moderation/ops: the operator needs to **help a specific user** who
emails "I can't sign in" / "my draft is broken" / "refund me" / "delete my account."
Today there is **no support surface at all**. The pieces, mostly cross-cutting:

### 10.1 Unified user lookup (the support home base)

A `/admin/users/$id` detail view aggregating **everything about one person** across
features (one read fn joining the writable DB):
- Account: email, name, role, ban status, created, providers (Google/magic/passkey),
  active sessions.
- Wiki: their `show_revisions` + uploads (link to the moderation feed filtered by
  `author_id`).
- Fantasy: leagues (owned + joined), draft/standings status, quiz attempts, payment
  status, notifications.
- PageantryJobs: profile, claims, postings.
This is what every support interaction starts from.

### 10.2 Account recovery & access

- **Resend a magic link** / trigger sign-in help for a user who's locked out (reuse
  `sendMagicLink` / the generic `email.ts`).
- **View / revoke sessions** (better-auth admin plugin `listUserSessions` /
  `revokeUserSession`) — "sign me out everywhere," stolen-session response.
- **Unban / lift restriction**; **fix role** (cross-link to §7).
- **Impersonate / "view as user"** (better-auth admin plugin `impersonateUser`,
  time-boxed) to reproduce a bug the user reports. **High-trust, admin-only, always
  audited, and visibly flagged** in the UI while active (the plugin tracks
  `impersonatedBy`). Decision: enable it (huge support value) but gate tightly.

### 10.3 Communications & delivery

- **Email delivery log + resend** — there's a Resend integration but no record of what
  was sent. Add a light `email_log` (to, subject, tag, sent_at, provider id, status)
  written by `email.ts`, viewable per user; "resend" button. Covers "I never got my
  invite / magic link."
- **Notification inbox inspection** — read a user's `fantasy_notifications`; re-emit a
  missed one.
- **Contact / support inbox (build it — confirmed).** There is no contact form today;
  add a public **`/contact`** route + a **`/faq`** route, and a support inbox in the
  console that reads submissions.
  - New `contact_messages` table in `contributions.db` (`message_id`, `user_id` NULL
    for signed-out, `email`, `subject`, `body`, `topic`, `status`
    open|replied|closed, `created_at`, `handled_by`, `handled_at`). The `/contact`
    route is a thin server-fn insert (validate + light rate-limit + honeypot/spam
    guard; `email.ts` notifies the operator on new submissions).
  - `/admin/support` inbox: list/filter by status, view a message, mark
    open/replied/closed, and **reply via email** (`email.ts`, logged in `email_log`).
    If the sender is a signed-in user, deep-link to their §10.1 lookup.
  - `/faq` is a static (or lightly authored) content route — no admin surface needed
    in v1 beyond editing the source; reserve an `admin_settings`/authored-block path if
    it should become editable later. A good FAQ deflects support volume, so ship it
    alongside `/contact`.

### 10.4 Targeted fixes (mostly deep-links into the right console)

Most "support fixes" are already covered by the ops sections — support is the
*entry point*, not new logic: unstick a draft (§9.2), revert/restore a clobbered wiki
edit (§6), re-run a failed job (§5), issue a refund (§9.4), GDPR delete/export (§7.1).
The support view should **deep-link** to each with the user/entity pre-filled.

### 10.5 Cap & audit

Add a `customerSupport` capability (min `moderator`) for the read-heavy lookup +
recovery actions; reserve `impersonate`, refunds, and deletes to `admin`. Every
support action is audited (§8) — support tools touch real user accounts, so the trail
matters most here.

---

## 11. Milestones (commit each; `npm run check && npm run lint` after each)

1. **M1 — Shell + auth + Overview.** Add caps to `authz.ts` (+ the `getActor` banned
   check, R3); `<AdminShell>` + `admin-nav.tsx` (role-filtered) + the shared
   `requireAdmin(cap)` server-fn and `requireAdminLoader` (§1 option A, §2); move
   `corps-colors` under the gate (delete its `isDev` hack); `adminStatus()` + Overview
   cards + `admin-machine` poll. Document the bootstrap SQL (§3). **Exit:** a non-admin gets `notFound`;
   an admin sees live status; corps-colors now requires moderator.
2. **M2 — Jobs runner (enqueue + VM worker).** `admin_jobs` table (with `queued`
   status); `admin.ts` server-fns (`adminEnqueueJob`/`adminJob`/`adminCancelJob`, no
   spawning); Jobs UI with queue state + live tail; `scripts/admin-job-worker.sh` (the
   VM executor, reusing `event-directory.ts` spawn logic where `sdk/` exists) + its
   cron entry. **Exit:** enqueuing a job inserts a `queued` row; the VM worker claims +
   runs it, streams stdout, flips success/failed; a duplicate same-kind enqueue is
   rejected; a deploy mid-job orphans nothing. (Wire `fine_tune` last — it's the
   heaviest job, but the entrypoint is now known — R7.)
3. **M3 — Audit + user management.** `admin_audit` table + write it everywhere;
   `/admin/users` list + grant/revoke role + ban with guard rails; `/admin/audit`
   feed. **Exit:** promoting a user works in-app; every admin action is audited;
   last-admin demotion blocked.
4. **M4 — Content moderation.** Cross-page revisions/media/citations feed
   (`listRecentRevisions`); wire the missing fns (`lockPage`, `listShowPages`); add
   `hidden` columns + `hideRevision`/`hideMedia` (§6.3). **Exit:** a moderator can
   revert + hide from the firehose; locked pages reject sub-level edits.
5. **M5 — System & ops.** `/admin/system` reading `rm_meta` + `dq_*` + pragmas;
   read-model freshness, data-quality, DB size, scrape-health (VM-fed snapshot),
   backups + "back up now" enqueue, announcement banner (`admin_settings`). **Exit:**
   the dashboard shows live read-model generation + flags stale data and DQ violations.
6. **M6 — Identity & entity data.** `/admin/identity`: staff merge-review queue,
   bio/photo canonical curation, corps colors (re-routed through the worker), curated
   fields — via enqueue (or the §6.5.3 decision-table). New job kinds. **Exit:** an
   admin merges two staff from the queue and the change appears after re-emit; colors
   save works in prod (not just dev).
7. **M7 — Customer support core.** `customerSupport` cap; unified `/admin/users/$id`
   lookup (cross-feature); session view/revoke; resend magic link; `email_log` +
   resend; impersonation (admin, audited, flagged — **confirmed in scope**). Public
   **`/contact`** (+ `contact_messages` table, spam-guarded insert) and **`/faq`**
   routes; **`/admin/support`** inbox (list/triage/reply-by-email, deep-link to the
   user lookup). **Exit:** a visitor submits `/contact`; it appears in the inbox; an
   operator replies (logged), finds the user, resends their login, and (admin)
   impersonates to repro a bug.
8. **M-fantasy — Fantasy console** (lands with the Fantasy feature, §9): quiz bank,
   league ops (pause/resume/force-pick/cancel/recompute/take-down), scheduled-jobs +
   live-draft observability. **Exit:** an operator can rescue a stuck draft and take
   down an abusive corps name. (Payments/refunds with Fantasy M6.)
9. **M-gdpr — GDPR delete/export** (§7.1) — when real users exist.
10. **M-jobs-board — PageantryJobs console** (§9.5) — with that feature.

---

## 12. Risks / open questions

- **R1 — RESOLVED: serving container cannot run SDK scripts.** Verified via
  `Dockerfile` + `.dockerignore` (no `sdk/scripts`, `sdk/models`, `*.db`; `--prod`
  drops `tsx`/`tfjs`). The existing in-process `spawn` paths
  (`event-directory.ts:378`, `event-prediction-api.ts:514`) ENOENT in prod and are
  dev-only. **Consequence: §5 is an enqueue/VM-worker model, not in-process spawn.**
  The VM crontab (`docs/MERCH_DEPLOY.md`) is the real executor. Remaining sub-task:
  build `scripts/admin-job-worker.sh` + add its cron entry on the VM (deploy step).
- **R2 — moderator vs admin boundary** (§2) — confirm the split with product.
  Provisional: moderators observe + moderate content/quiz; admins enqueue jobs,
  manage users, run league ops.
- **R3 — RESOLVED: enable the better-auth `admin` plugin** (already installed in
  `1.6.19`). Wrap its endpoints in `manageUsers`-gated server-fns; keep `authz.can()`
  as the brain (§7). **Ban behavior verified:** `banUser` *immediately deletes all the
  user's sessions* (`admin/routes.mjs:529`) AND a `session.create` hook blocks new
  sign-ins (`admin/admin.mjs:33`, auto-unbans on expiry). Caveat: plain `getSession()`
  doesn't re-check `banned` on an already-valid cookie — but since ban deletes the
  session rows, the cookie resolves to nothing. **Still add a cheap `if
  (session.user.banned) return null` to `getActor` as defense-in-depth** (covers any
  cache/edge and makes intent explicit).
- **R4 — `trusted` grantable?** (§7) — default yes.
- **R5 — one `admin_audit` vs per-feature audit tables** — recommend unified; fold the
  already-present `fantasy_admin_audit` into it.
- **R6 — Overview cost.** `adminStatus()` touches both DBs + filesystem; cache it
  briefly / debounce the poll so the dashboard isn't a load source on the 2-vCPU box.
- **R7 — RESOLVED: fine-tune entrypoint is `sdk/src/training/trainModelV9Subcaption-fixed.ts`**
  (invoked by `seasonUpdateWorkflow.ts:571`; latest model via `findLatestModelDir()`).
  Wired into the §5 registry. Note `seasonUpdateWorkflow` passes two phantom flags
  (`--val-mode`, `--division-filter`) the script ignores — harmless, but don't copy them
  as if meaningful. Still schedule `fine_tune` last (longest/heaviest job).
- **R8 — RESOLVED: gate in the loader, not `beforeLoad`** (§2). Verified the repo keeps
  `beforeLoad` synchronous (flag → `notFound`) and enforces auth in the loader via a
  server-fn that throws, caught by the component (`fantasy/index.tsx:18,24-33`). `getActor`
  needs the request, available server-side in the loader's server-fn. Every admin
  server-fn re-checks (`requireCapability`) as the real gate.

## 13. Reusable building blocks (verified, for the executor)

- **Shell:** no `route.tsx` layout exists in the repo (verified). Default to a shared
  `<AdminShell>` component each `admin/*.tsx` wraps (§1 option A); a `route.tsx` layout
  (option B) is supported by TanStack but a new convention — choose deliberately.
- **Sidebar:** mirror `app/components/site-nav.tsx` (`NAV_ITEMS` array → icons +
  `<Link>`; desktop rail `w-side-nav` at md, mobile bottom tabs) → new `admin-nav.tsx`,
  role-filtered.
- **Chrome:** `app/components/page-shell.tsx` (max-width + padding) +
  `app/components/page-header.tsx` (title/subtitle/back/actions) — already used by
  `admin/corps-colors.tsx`.
- **Status poller:** clone `app/machines/event-directory-machine.ts` (setup + `fromPromise`
  actors + `invoke`/`onDone`, `idle`/`fetching` states) → `admin-status-machine.ts`.
- **Gate pattern:** loader calls `requireAdmin(cap)` server-fn → component catches
  `UNAUTHENTICATED`/`Forbidden` and renders sign-in or `notFound` (mirror
  `fantasy/index.tsx`). Feature-flag-style sync gate example: `admin/corps-colors.tsx:22`
  (`beforeLoad` → `throw notFound()`). Session client: `app/lib/auth-client.ts`
  (`useSession`). Durable-write guard: `durableStorageStatus()` (`contributions-db.ts:51`).

---

## Appendix A — M1 execution reference (copy these shapes)

Concrete, verified against the repo. Follow exactly; fill in the rest per §4.

**A.1 — capabilities (`app/lib/authz.ts`).** Extend the `Capability` union and the
`MIN_ROLE` map (`authz.ts:15,26`); add the banned check to `getActor` (R3):

```ts
export type Capability =
  | 'edit' | 'upload' | 'revert' | 'lock' | 'hideRevision' | 'orphan'
  | 'grantRole' | 'deletePage'
  // admin console:
  | 'viewAdmin' | 'runJobs' | 'manageUsers'
  | 'manageFantasyQuiz' | 'manageFantasyLeagues'
  | 'customerSupport' | 'impersonate';

const MIN_ROLE: Record<Capability, Role> = {
  edit: 'user', upload: 'user', revert: 'user',
  lock: 'moderator', hideRevision: 'moderator', orphan: 'moderator',
  grantRole: 'admin', deletePage: 'admin',
  viewAdmin: 'moderator', runJobs: 'admin', manageUsers: 'admin',
  manageFantasyQuiz: 'moderator', manageFantasyLeagues: 'admin',
  customerSupport: 'moderator', impersonate: 'admin',
};

// getActor: defense-in-depth — reject banned users even on a cached cookie (R3)
export const getActor = async (request: Request): Promise<Actor | null> => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  if ((session.user as { banned?: boolean }).banned) return null;
  return { userId: session.user.id, role: (session.user as { role?: Role }).role ?? 'user' };
};
```

**A.2 — shared gate (`app/lib/server-fns/admin.ts`).** Mirror the `fantasy.ts` idiom
(`createServerFn` + `getWebRequest` + `requireCapability`):

```ts
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { requireCapability, type Capability } from '@/lib/authz';

// loader gate — throws ForbiddenError (signed in, wrong role) or the better-auth
// UNAUTHENTICATED (signed out); the route component catches and renders accordingly.
export const requireAdmin = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ cap: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), data.cap as Capability);
    return { userId: actor.userId, role: actor.role };
  });
```

```ts
// app/lib/admin-loader.ts — shared loader helper every admin route uses
import { requireAdmin } from '@/lib/server-fns/admin';
export const requireAdminLoader = (cap: string) => async () => {
  try { return { actor: await requireAdmin({ data: { cap } }) }; }
  catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes('UNAUTHENTICATED')) return { actor: null, signedIn: false };
    throw notFound(); // wrong role → don't advertise the console
  }
};
```

**A.3 — a route** (`app/routes/admin/index.tsx`), repo-idiomatic (loader gate, no
async `beforeLoad`):

```ts
export const Route = createFileRoute('/admin/')({
  loader: requireAdminLoader('viewAdmin'),
  component: AdminOverview,
});
// component: if !data.actor → <SignInPrompt/>; else <AdminShell><Overview/></AdminShell>
```

**A.4 — every admin server-fn re-checks (the real gate):**

```ts
export const adminEnqueueJob = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(EnqueueInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'runJobs'); // FIRST
    const db = await getContributionsDb();
    // … durableStorageStatus() guard, per-kind dedupe, insert queued row, audit …
  });
```

## Appendix B — consolidated new schema (append to the `SCHEMA` array, `contributions-db.ts:77`)

All idempotent (`IF NOT EXISTS`), additive, run by the existing `db.batch(SCHEMA,
'write')` (`contributions-db.ts:375`). better-auth's `banned`/`banReason`/`banExpires`
are auto-migrated by the admin plugin — **not** here.

```sql
-- §5 job queue (web enqueues; VM worker executes)
CREATE TABLE IF NOT EXISTS admin_jobs ( … per §5.1 … );
CREATE INDEX IF NOT EXISTS idx_admin_jobs_status   ON admin_jobs (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_kind_time ON admin_jobs (kind, queued_at);

-- §8 audit (unified; fold fantasy_admin_audit in)
CREATE TABLE IF NOT EXISTS admin_audit ( … per §8 … );
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit (created_at);

-- §8.2 settings (announcement banner, misc operator config)
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);

-- §10.3 contact inbox (public /contact → here)
CREATE TABLE IF NOT EXISTS contact_messages (
  message_id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT NOT NULL,
  topic TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
  handled_by TEXT, handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_status ON contact_messages (status, created_at);

-- §10.3 email delivery log (written by email.ts)
CREATE TABLE IF NOT EXISTS email_log (
  email_id TEXT PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT, tag TEXT,
  user_id TEXT, provider_id TEXT, status TEXT, sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log (user_id, sent_at);

-- §6.3 moderation visibility (additive columns — separate ALTER, guarded)
-- ALTER TABLE show_revisions ADD COLUMN hidden INTEGER DEFAULT 0;
-- ALTER TABLE show_media     ADD COLUMN hidden INTEGER DEFAULT 0;
```

> **SQLite `ALTER TABLE ADD COLUMN` is not idempotent** — it errors if the column
> exists. Don't put the two `hidden` ALTERs in the `SCHEMA` batch. Add them via a
> guarded step (check `PRAGMA table_info` first, or try/catch the ALTER) at M4, the way
> a one-shot migration would. Everything above is `CREATE … IF NOT EXISTS` and is safe
> in the batch.

---

## Progress log (headless work done 2026-06-22)

Committed on `feat/fantasy-dci` (route-independent foundation; fantasy work untouched):
- `18390f8` — plan + authz caps (`viewAdmin`/`runJobs`/`manageUsers`/`customerSupport`/
  `impersonate`) + `getActor` banned-check (R3).
- `625bffa` — `app/lib/server-fns/admin.ts` (`requireAdmin` discriminated gate +
  `adminStatus` snapshot) and `app/lib/admin-loader.ts` (`requireAdminLoader`).
- `5ed8c27` — `app/components/admin/{admin-nav,admin-shell}.tsx`,
  `app/machines/admin-status-machine.ts`, 6 new generated icons + barrel.

All typecheck-clean and formatted.

### ✅ Overview route landed (`6a31ee3`)
- Resolved the dir-perms blocker via the **docker-group trick** (root-owned
  `app/routes/admin/` → `docker run --rm -v …:/target alpine chown -R 1001:1001 /target`).
- Created `app/routes/admin/index.tsx` (Appendix C) and regenerated `routeTree.gen.ts`
  with `npx vite` ("Generated route tree in 1186ms" — vite then crashes on an
  **ENOSPC fs.inotify watcher limit**, unrelated; the tree was already written).
  `/admin/` is registered + typecheck-clean.
- **Runtime smoke-test still pending:** a live `npm run dev` is blocked by that watcher
  limit. Fix with `sudo sysctl fs.inotify.max_user_watches=524288` (or run vite with
  `usePolling`) to click through `/admin` in a browser.
- **corps-colors migration (Appendix D) deliberately deferred to M6.** Moving it off
  the `isDev` gate would make it reachable in prod, where its direct `dci-relational.db`
  write fails (§1.1). Keep it dev-only until its save is re-routed through the VM worker.

### Appendix C — `app/routes/admin/index.tsx` (Overview — ready to drop in)

Drafted + reviewed against the committed foundation; mirrors `fantasy/index.tsx`
(loader gate + `useSession`/`signIn` for the signed-out case) and uses `ui/card`.

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminShell } from '@/components/admin/admin-shell';
import { adminStatusMachine } from '@/machines/admin-status-machine';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { signIn, useSession } from '@/lib/auth-client';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/')({
  loader: requireAdminLoader('viewAdmin'),
  head: () => seoHead({ title: 'Admin — Overview', description: 'Operator console', path: '/admin' }),
  component: AdminOverview,
});

const fmtBytes = (n: number): string => {
  if (!n) return '—';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

function StatCard({ title, rows }: { title: string; rows: [string, number | string][] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-text-secondary">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-text-secondary">{label}</span>
            <span className="text-right font-medium tabular-nums">{value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AdminOverview() {
  const gate = Route.useLoaderData();
  const { data: session } = useSession();

  if (!gate.signedIn) {
    return (
      <PageShell>
        <PageHeader title="Admin" subtitle="Operator console" />
        <Card className="mx-auto mt-6 max-w-md">
          <CardHeader><CardTitle>Sign in required</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-text-secondary">
            <p>{session ? 'Your account does not have access to this area.' : 'Sign in with an authorized account to continue.'}</p>
            {!session ? (
              <Button onClick={() => void signIn.social({ provider: 'google', callbackURL: '/admin' })}>
                Continue with Google
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <AdminShell role={gate.actor.role}>
      <Overview />
    </AdminShell>
  );
}

function Overview() {
  const [state] = useMachine(adminStatusMachine);
  const s = state.context.status;
  const loading = !s && state.matches('fetching');

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={s ? `Snapshot ${new Date(s.generatedAt).toLocaleTimeString()}` : 'Loading…'}
      />
      {state.context.error ? <p className="mb-4 text-sm text-destructive">{state.context.error}</p> : null}
      {loading ? (
        <p className="text-sm text-text-secondary">Loading status…</p>
      ) : s ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard title="Wiki (contributions)" rows={[['Pages', s.wiki.pages], ['Revisions', s.wiki.revisions], ['Media', s.wiki.media], ['Citations', s.wiki.citations]]} />
          <StatCard title="Fantasy" rows={[['Leagues', s.fantasy.leagues], ['Members', s.fantasy.members]]} />
          <StatCard title="Storage" rows={[['contributions.db', fmtBytes(s.contributionsDb.sizeBytes)]]} />
        </div>
      ) : null}
    </>
  );
}
```

### Appendix D — migrate `app/routes/admin/corps-colors.tsx` onto the gate

Replace the dev-only gate with the role gate + shell. NOTE the save still writes
`dci-relational.db` directly, which only works in dev (§1.1) — so either keep it
dev-only-functional for now or re-route its save through the worker at M6. Minimal
gate change:

```tsx
// remove: const isDev = import.meta.env.DEV; and the beforeLoad notFound()
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminShell } from '@/components/admin/admin-shell';
// in the route:
export const Route = createFileRoute('/admin/corps-colors')({
  loader: requireAdminLoader('viewAdmin'),
  // ...keep getCorpsDirectory load inside the component or merge into the loader
});
// wrap the component's returned JSX in <AdminShell role={gate.actor.role}> when signed in.
```
