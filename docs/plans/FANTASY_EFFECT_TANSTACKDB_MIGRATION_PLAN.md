# Fantasy DCI — Migrate the backend to Effect + TanStack DB

Status: **DRAFT for review** · Created: 2026-06-23 · Owner: TBD

Migrates the Fantasy DCI feature from its current `createServerFn` + raw
`@libsql/client` + hand-rolled concurrency backend to the codebase's blessed
architecture (AGENTS.md): **Effect Services/Layers + Effect RPC for
mutations/logic, and TanStack DB collections + `useLiveQuery` for client reads**,
on **Effect v4 beta**. The browser bundle stays Effect-free.

This is a re-architecture of *working, tested* code (52 unit + integration tests,
all green). It is therefore a **strangler migration behind the existing
`VITE_ENABLE_FANTASY` flag** — never a big-bang — gated on live E2E.

---

## 0. TL;DR

- Keep every **pure** module as-is (`scoring`, `draft`, `draft-order`, `config`,
  `quiz`, `captions`, `standings.buildStandings`) — they're framework-agnostic
  and unit-tested. Services *call* them.
- Replace the `throw new Error('CONFLICT:reason')` + `matchMessage` string scheme
  with **`Schema.TaggedErrorClass` domain errors** + `catchTag` (the single
  biggest correctness win).
- Wrap DB access in an **`effect/unstable/sql` `SqlClient`** layer over
  `contributions.db` (+ a read-only one over `dci-relational.db`), matching the
  SDK's Effect+SQL convention.
- Express mutations/logic as **Effect Services** (`app/lib/fantasy/services/*`)
  exposed via an **Effect RPC group** (`app/rpc/fantasy-rpc.ts`), merged into
  `AppLive`. `createServerFn` becomes a thin boundary that `Effect.runPromise`s,
  then is removed where the RPC client/collections replace it.
- Re-implement the **stateful draft engine** on Effect primitives — `Semaphore`
  (per-league lock), `PubSub` (SSE fan-out), `Fiber` + `Schedule` (auto-pick
  clock + self-heal), `Scope` (lifecycle). This is the highest-value and
  highest-risk piece.
- Client **reads** move to **TanStack DB collections** (`app/db/fantasy-*`)
  queried with `useLiveQuery`; the live draft collection is fed by the SSE
  stream; mutations are **optimistic** through collection mutation handlers that
  call the RPC. The existing **XState session machines** stay, but their actors
  delegate to the RPC/services instead of `createServerFn` directly.

---

## 0.5 Grounding — the patterns this plan mirrors (verified in-repo)

- **Effect Service (v4):** `const makeXService = Effect.gen(function* () { const m = Effect.fn('X.m')(function* (…) {…}); return { m, … } })`, then `export class XService extends Context.Service<XService, Effect.Success<typeof makeXService>>()("XService") {}` and `export const XServiceLive = Layer.effect(XService, makeXService)`. See `app/lib/event-directory.ts`.
- **Domain errors:** `Schema.TaggedErrorClass` (e.g. `EventDirectoryDataError` in `event-directory.ts`).
- **RPC:** `RpcGroup.make(Rpc.make('name', { success: Schema, error: Schema (tagged) }))` → `XRpc.toLayer({ name: ({ payload }) => Effect… })` = `XRpcLive`; merge into `AppLive = Layer.mergeAll(…)` in `app/rpc/index.ts`. See `app/rpc/directory-rpc.ts` + `index.ts`.
- **Boundary:** server-fn/route handler does `Effect.runPromise(program.pipe(Effect.provide(AppLive)))` (`provideAppLive` in `app/rpc/index.ts`). Per AGENTS.md, `runPromise` lives ONLY at boundaries (server-fn handlers, XState actions, collection `sync` bridges) — never in a service body.
- **TanStack DB:** `createCollection(jsonIndexCollectionOptions<T>({ id, getKey, shard }))` for static shards (`app/db/collections.ts`); the sync contract is `sync: ({ begin, write, commit, markReady }) => …` (`app/db/json-collection.ts`).
- **v4 deltas (AGENTS.md):** `effect/unstable/sql`, `effect/unstable/rpc`, `Schema.TaggedErrorClass`, `Schema.Literals([…])`, `SchemaParser.decodeUnknownEffect`, `Effect.catch`, `effect/Result`, `Effect.callback`, `Effect.log` (not `console.log`), `sql<Row>` returns `Row[]`. No `.Default`/`dependencies:` — `Layer.provide([…Live])` on the `*Live`.

---

## 1. Goals & Non-Goals

### Goals
1. Bring the fantasy backend onto Effect Services + Effect RPC; client reads onto
   TanStack DB `useLiveQuery`; conform to AGENTS.md.
2. Typed errors end-to-end (no string matching).
3. Model concurrency (lock/timer/pub-sub) with Effect primitives instead of
   ad-hoc `Promise` chains + `setTimeout` + `Map`s.
4. Keep the browser bundle **Effect-free** (reads = plain fetch/SSE; Effect is
   server-only) — guard against the contrib `node:fs`-into-client-chunk leak.
5. Zero behavior change for users; everything stays behind `VITE_ENABLE_FANTASY`.

### Non-Goals
- No feature changes. No schema changes to `fantasy_*` tables (the SQL layer
  changes, not the columns).
- Not rewriting the **pure** logic (already correct + tested).
- Not adopting TanStack DB *persistence* (the installed `0.1.86` has none; SW
  owns offline — AGENTS.md).
- Not changing the single-process assumption (A8/V1): Effect `Semaphore`/`PubSub`
  are still in-process, like today's `Map`-based lock/bus.

---

## 2. Current state (what we're migrating)

| Concern | Today | File |
|---|---|---|
| Mutations + reads | `createServerFn` (~1,300 lines) | `app/lib/server-fns/fantasy.ts`, `fantasy-media.ts` |
| DB access | raw `@libsql/client` `db.execute({sql,args})` | everywhere |
| Errors | `throw new Error('CONFLICT:reason')` + client `matchMessage` | server-fns + routes |
| Draft engine | `Promise`-chain mutex `Map`, `setTimeout` timer `Map`, self-heal flag | `app/lib/fantasy/draft-engine.ts` |
| SSE fan-out | `Map<leagueId, Set<controller>>` | `app/lib/fantasy/bus.ts`, `app/routes/api/fantasy/draft/$leagueId/stream.ts` |
| Live client | `useSyncExternalStore` over an `EventSource` store | `app/lib/fantasy/use-draft-stream.ts` |
| Session UI state | **XState machines (already done)** | `app/machines/fantasy-{quiz,draft}-machine.ts` |
| Other form UI state | `useAsyncAction` (useState loading/error) | create/join/invite/identity/push/quiz-admin |
| Pure logic | framework-agnostic, unit-tested | `scoring`, `draft`, `draft-order`, `config`, `quiz`, `captions`, `standings.buildStandings` |
| Recompute / cron | app-side Effect-free | `standings.ts`, `jobs.ts`, `routes/api/fantasy/jobs/*` |
| External SDKs | Stripe, web-push, Resend, R2, sharp (raw) | `payments.ts`, `push.ts`, `email.ts`, `fantasy-media.ts` |

---

## 3. Target architecture

```
            ┌────────────────────────── server (Effect) ──────────────────────────┐
 routes ──▶ │ app/rpc/fantasy-rpc.ts  (RpcGroup; mutations + reads)                │
 (loaders/  │   └─ delegates to ─▶ app/lib/fantasy/services/*  (Context.Service)   │
  SSE)      │        LeagueService, MembershipService, InviteService,              │
            │        QuizService, DraftService, StandingsService,                  │
            │        PaymentService, NotificationService, MediaService             │
            │   └─ each uses ─▶ ContributionsSql (SqlClient over contributions.db) │
            │                     ScoreSql (read-only SqlClient over relational.db) │
            │   └─ calls ─▶ PURE: scoring/draft/draft-order/config/quiz/standings   │
            │   merged into AppLive (app/rpc/index.ts)                              │
            └───────────────────────────────────────────────────────────────────────┘
                       ▲ Effect.runPromise(... Effect.provide(AppLive)) at boundaries
                       │
            ┌──────────┴──────── client (Effect-FREE) ─────────────────────────────┐
 components │ TanStack DB collections (app/db/fantasy-*) ── useLiveQuery            │
 (dumb)     │   leaguesCollection, leagueDetailCollection, standingsCollection,     │
            │   draftCollection (fed by the SSE stream)                            │
            │ XState machines (app/machines/fantasy-*) — actors call the RPC client │
            │ Optimistic mutations via collection mutation handlers ──▶ RPC         │
            └───────────────────────────────────────────────────────────────────────┘
```

### 3.1 SQL layer
`app/lib/fantasy/services/sql.ts`:
- `ContributionsSql` = `LibsqlClient.layer({ url: CONTRIBUTIONS_DB_URL })` (from
  `effect/unstable/sql` + the libsql client integration the SDK uses). Replaces
  `getContributionsDb`. Keep the same PRAGMAs + `ensureColumns`/SCHEMA bootstrap
  (run once via a layer that executes the DDL on acquire).
- `ScoreSql` = a **read-only** `SqlClient` over `DCI_RELATIONAL_DB_URL`. Replaces
  the lazy client in `score-db.ts`; the queries (C.2/C.3/C.4) become `sql`
  templates. **Never write** to it (lint/comment guard).
- Durable fail-closed (I-7): a `requireDurableStorage` Effect that fails with a
  `StorageUnavailableError` before any write — provided to write services.

### 3.2 Domain errors (replace the string scheme)
`app/lib/fantasy/services/errors.ts` — one `Schema.TaggedErrorClass` per case:
`Unauthenticated`, `Forbidden`, `NotFound`, `LeagueConflict({ reason })` (reason a
`Schema.Literals(['unpaid','draft-started','full','used-up','name-taken','already-paid','not-paid','rate-limited',…])`),
`DraftConflict({ reason })`, `QuizConflict({ reason })`, `PaymentDisabled`,
`StorageUnavailable`, `RateLimited`. The RPC `error` schema is the union of these
`_tag`s; the client maps `_tag`→message via `effect/Match` (`Match.tag`), deleting
`matchMessage`.

### 3.3 Services (one per bounded slice)
Each is a v4 `Context.Service`. Public methods are `Effect.fn('Service.method')`.
Authz (`getActor`), rate-limit, durable-guard become Effects composed in.

- **LeagueService** — create/get/list/updateConfig (config freezes via the pure
  `draftShapeChanged` + `getSeasonFinals`).
- **MembershipService** — setCorpsIdentity, removeMember.
- **InviteService** — create/revoke/getInvite + the race-safe `acceptInvite`
  (the atomic `used_count` CAS becomes a `sql` `UPDATE … RETURNING`/rowsAffected
  inside an Effect transaction; seat-release via `Effect.ensuring`).
- **QuizService** — admin CRUD (capability-gated) + `getQuizForLeague` (no
  `correct_index` ever in the success schema) + `submitQuiz` (guarded completing
  UPDATE; uses pure `scoreQuiz`/`planQuestionCounts`).
- **DraftService** — schedule/start/pick/pause/resume/getSnapshot + the engine
  (see §3.4).
- **StandingsService** — `recompute(season)` (uses pure `buildStandings`) +
  `getStandings(slug)`.
- **PaymentService** — Stripe checkout/webhook-verify/refund (wraps the SDK in an
  Effect service; `Effect.tryPromise` → `PaymentError`).
- **NotificationService** — enqueue + dispatch (jobs.ts) + email/push (wrap
  Resend/web-push as Effect services).
- **MediaService(fantasy)** — sharp→WebP→R2 logo upload as an Effect.

### 3.4 The draft engine on Effect (the crux)
Replace `draft-engine.ts`'s hand-rolled state with a `DraftService` holding
process-scoped Effect state (one `Scope` for the app):
- **Per-league lock** `Map<leagueId, Semaphore>` (each `Effect.makeSemaphore(1)`);
  `makePick`/`runAutoPick` run inside `semaphore.withPermits(1)`. Replaces the
  `Promise`-chain `chains` map.
- **SSE fan-out** one `PubSub<DraftEvent>` per league (`Effect.makePubSub`), or a
  single keyed `PubSub`. The SSE route subscribes a `Stream` from it. Replaces
  `bus.ts`'s `Set<controller>`.
- **Auto-pick clock** a supervised `Fiber` per live league running
  `Effect.sleep(deadline) *> runAutoPickIfDue`, re-armed on each advance;
  `Schedule`/`Fiber.interrupt` replace `setTimeout`/`clearTimeout`. **Self-heal**:
  on layer acquire, scan `status='live'` drafts and fork their fibers (replaces
  the `selfHealed` flag).
- **Lifecycle** all timers/pubsubs live in the `DraftService` layer's `Scope`, so
  shutdown is clean (vs. leaking `setTimeout`s today).
- The pure advance math (`userAt`/`pickWeight`/`isDraftComplete`/`legalityError`)
  is unchanged; the service orchestrates it inside the semaphore + a `sql`
  transaction (`SqlClient` `withTransaction`).

### 3.5 RPC + boundaries
`app/rpc/fantasy-rpc.ts` — `FantasyRpc = RpcGroup.make(Rpc.make('createLeague', …), …)`,
`FantasyRpcLive = FantasyRpc.toLayer({ createLeague: ({ payload }) => LeagueService.create(payload), … })`;
add `FantasyRpcLive` + the service `*Live`s to `AppLive`. During the strangler the
existing route `createServerFn`s keep their signatures but their handlers become
`Effect.runPromise(FantasyRpc-handler.pipe(provideAppLive))` — call sites
(machines, loaders) don't change until P5.

### 3.6 Client reads = TanStack DB
`app/db/fantasy-collections.ts`. Fantasy data is **dynamic** (not static
read-model shards), so these are **server-backed** collections, NOT
`jsonIndexCollectionOptions`:
- `leaguesCollection` (my leagues), `leagueDetailCollection`,
  `standingsCollection` — a `sync` that fetches the current value from the RPC
  (or a `queryCollectionOptions`-style adapter) and `markReady()`; refetched on
  mutation/`invalidate`.
- `draftCollection` — its `sync` opens the **SSE EventSource** and writes
  `snapshot`/`pick`/`state` deltas into the collection (`begin/write/commit`),
  replacing `use-draft-stream.ts`. Components `useLiveQuery(draftCollection)`.
- **Optimistic mutations**: collection mutation handlers call the RPC and let the
  server snapshot reconcile (the draft pick is the prime case — optimistic
  insert, reconcile from the SSE `pick`). Per AGENTS.md the `sync` bridge is an
  allowed `runPromise`/`fetch` boundary; keep Effect out of it.

### 3.7 XState machines
`fantasy-quiz-machine` / `fantasy-draft-machine` stay (already built). Their
`fromPromise` actors swap `getQuizForLeague`/`makePick`/etc. for the **RPC
client** call. Components still render from `state.matches()`/`context` + the
`useLiveQuery` collections. (AGENTS.md: machine actions delegate to services.)

---

## 4. Server-fn → target mapping

| Today (`server-fns/fantasy.ts`) | Target |
|---|---|
| createLeague / updateLeagueConfig | LeagueService → RPC mutation |
| getLeague / listMyLeagues | LeagueService read → `leaguesCollection` / `leagueDetailCollection` (`useLiveQuery`) |
| createInvite / revokeInvite / getInvite / acceptInvite | InviteService → RPC |
| setCorpsIdentity / removeMember | MembershipService → RPC |
| admin quiz CRUD / getQuizForLeague / submitQuiz | QuizService → RPC (quiz machine actor) |
| scheduleDraft/startDraft/makePick/pause/resume | DraftService → RPC (draft machine actor) |
| getDraftState + SSE stream | DraftService snapshot + PubSub stream → `draftCollection` |
| getStandings | StandingsService read → `standingsCollection` |
| createLeagueCheckout / requestRefund / webhook | PaymentService → RPC + webhook route Effect |
| getVapidPublicKey / save/deletePushSubscription | NotificationService → RPC |
| uploadFantasyLogo | MediaService → RPC |
| jobs dispatch / recompute routes | NotificationService.dispatch / StandingsService.recompute (Effect at route boundary) |

---

## 5. Milestones (each shippable behind the flag; tests stay green)

> Strangler order: introduce Effect *under* the existing server-fns first
> (no call-site churn), then move reads to collections, then swap the engine,
> then delete shims. Commit per slice (AGENTS.md).

- **P0 — Foundations.** `ContributionsSql`/`ScoreSql` layers (+ DDL bootstrap);
  `errors.ts` (TaggedErrorClass); `AppLive` extended; a `provideFantasy` helper;
  one trivial service (e.g. `LeagueService.get`) proven end-to-end through a
  server-fn shim. **Accept:** `getLeague` returns identical data via the Effect
  path; existing tests pass; `vp check` clean; browser bundle has no Effect/node.
- **P1 — Read services + collections.** LeagueService + StandingsService reads;
  `leaguesCollection`/`leagueDetailCollection`/`standingsCollection`; convert
  `/fantasy`, `/fantasy/$slug`, `/fantasy/$slug/standings` to `useLiveQuery`
  (loader still SSRs first paint). **Accept:** pages render from collections;
  SSR unchanged; no Effect in client chunk.
- **P2 — Mutation RPC (non-draft).** League/Invite/Membership/Quiz services + RPC;
  quiz machine actor → RPC; typed errors mapped via `Match.tag` (delete
  `matchMessage` for these). **Accept:** create→invite→Google→join→quiz E2E green
  on the Effect path; the invite-accept race + quiz double-submit guards hold
  (port the integration assertions).
- **P3 — Draft engine on Effect (highest risk).** DraftService with
  Semaphore/PubSub/Fiber/Schedule/self-heal; SSE route from the PubSub stream;
  `draftCollection` fed by SSE; optimistic `makePick`; draft machine actor → RPC.
  **Accept:** the **draft-engine integration test is re-pointed at the Effect
  service** (provide test SqlClient layers) and passes — full snake draft,
  legality via unique indexes, auto-pick, restart self-heal; live multi-client
  click-through.
- **P4 — Standings + cron + external SDKs.** StandingsService.recompute (Effect),
  NotificationService (jobs + Resend/web-push), PaymentService (Stripe),
  MediaService; webhook + jobs + recompute routes run Effect programs. **Accept:**
  the **standings integration test re-pointed at StandingsService** reproduces
  the Appendix-D recap (95.40), idempotent, finals lock; Stripe test-mode flow.
- **P5 — Remove shims.** Delete the `createServerFn` wrappers that are now fully
  replaced by the RPC client + collections; delete `useAsyncAction` from the
  fantasy components (forms move to machine/`useActionState` as appropriate);
  delete `bus.ts`/`use-draft-stream.ts`/`draft-engine.ts` legacy. **Accept:** no
  `createServerFn`/`useAsyncAction`/raw `@libsql/client` left under `app/**/fantasy*`;
  `vp check` + all tests green.

---

## 6. Testing strategy

- **Keep the pure unit tests unchanged** (scoring/draft/draft-order/config/quiz/
  rate-limit/standings.buildStandings) — the pure modules don't move.
- **Port the two integration tests to the Effect path**: the harness already sets
  `CONTRIBUTIONS_DB_URL`/`DCI_RELATIONAL_DB_URL` to temp libsql files and stubs
  the `user` table; instead of importing `draft-engine`/`standings`, build a test
  `AppLive` (the real services over the temp `SqlClient`) and `Effect.runPromise`
  the service methods. Same assertions (snake order/weights/completion/legality;
  recap 95.40/idempotent/finals lock).
- **New Effect-level tests** per service via `Effect.runPromise(program.pipe(Effect.provide(TestLive)))`.
- **Parity gate**: during the strangler, a temporary test asserts old-path vs
  new-path return equality for `getLeague`/`getStandings`.
- `Effect.log` capture for error-path tests (TaggedError `_tag` assertions via
  `catchTag`).

---

## 7. Risks & mitigations

- **R1 — Effect v4 is beta.** Pin to `effect@4.0.0-beta.80`; follow the
  `EFFECT_V4_MIGRATION_PLAN.md` deltas exactly (renames in §0.5). Mitigate churn
  by isolating Effect to `app/lib/fantasy/services/*` + `app/rpc/`.
- **R2 — Draft-engine concurrency rewrite (highest risk).** Semaphore/Fiber/PubSub
  replacing the hand-rolled lock/timer/bus is where subtle bugs hide. Mitigate:
  the integration test is the net (re-point it FIRST in P3, before deleting the
  old engine); keep both engines behind a sub-flag during P3 for A/B.
- **R3 — Effect leaking into the client bundle** (cf. the contrib `node:fs`
  blank-site incident — see memory `contrib-client-bundle-node-leak`). Mitigate:
  collections' `sync` and the RPC *client* are plain `fetch`/`EventSource`
  (Effect-free); services/RPC handlers are server-only (imported only by routes/
  server-fns). **Verify the client chunk has no `effect`/`node:` after P1 and
  P3** before deploy.
- **R4 — SSE↔PubSub↔TanStack DB live wiring is unverifiable without the app.**
  Mitigate: build it behind the flag, integration-test the server PubSub in
  isolation, and gate merge on a real multi-client draft click-through.
- **R5 — Per-process state (A8/V1).** Semaphore/PubSub/Fiber are in-process, same
  assumption as today; a horizontal scale-out still needs a shared transport.
  Document; no regression.
- **R6 — Two processes writing `contributions.db`** (app + scrape recompute). The
  `SqlClient` over the same file keeps WAL + busy_timeout; unchanged from today.
- **R7 — No local builds on the 4 GB box** (memory `no-local-builds-on-prod-vm`):
  verify via `vp check`/tests + the deployed container, not a local `vite build`.

---

## 8. Target file map

```
app/lib/fantasy/services/
  sql.ts                 # ContributionsSql + ScoreSql layers (+ DDL bootstrap, durable guard)
  errors.ts              # Schema.TaggedErrorClass domain errors
  actor.ts               # getActor/requireCapability as Effects
  rate-limit.ts          # the limiter as an Effect (or keep pure + wrap)
  league-service.ts      # LeagueService + Live
  membership-service.ts
  invite-service.ts
  quiz-service.ts
  draft-service.ts       # the engine: Semaphore/PubSub/Fiber/Schedule/self-heal
  standings-service.ts
  payment-service.ts
  notification-service.ts
  media-service.ts
app/rpc/fantasy-rpc.ts   # FantasyRpc group + FantasyRpcLive (added to AppLive)
app/rpc/index.ts         # + FantasyRpcLive, + service *Live in AppLive
app/db/fantasy-collections.ts  # leagues/leagueDetail/standings/draft collections
app/lib/fantasy/rpc-client.ts  # Effect-free RPC client for machines/collections
# unchanged (pure): scoring.ts, draft.ts, draft-order.ts, config.ts, quiz.ts,
#                    captions.ts, standings.ts (buildStandings stays)
# deleted at P5: server-fns/fantasy.ts shims, bus.ts, use-draft-stream.ts,
#                draft-engine.ts, use-async-action usages in fantasy
```

---

## 9. Open questions (resolve before P3/P4)

- **Q1 — Read transport for collections.** Server-backed TanStack DB collections:
  use a custom `sync` that calls the RPC client, or `@tanstack/query`-backed
  collection options? Decide by what `0.1.86` supports cleanly (the repo only
  uses `jsonIndexCollectionOptions` today; this is a new pattern — spike it).
- **Q2 — Optimistic draft pick reconciliation.** Confirm the collection's
  optimistic insert reconciles correctly when the authoritative SSE `pick`
  arrives (key by `pick_no`); define rollback on RPC error.
- **Q3 — One PubSub vs per-league.** A single keyed `PubSub` filtered per league
  vs a `Map<leagueId, PubSub>` with lifecycle. Lean per-league + Scope cleanup.
- **Q4 — Webhook/cron boundaries.** These are non-RPC HTTP routes; confirm they
  `Effect.runPromise(... provideAppLive)` cleanly without the RPC envelope.
- **Q5 — Keep `createServerFn` for SSR loaders?** Loaders run server-side; they
  can call services directly via `runPromise`. Decide whether loaders use the RPC
  group or the services directly (likely services directly; RPC for client).

---

## 10. Sequencing note

Do **not** start before the **live E2E verification** of the current feature —
never re-architect code that hasn't been seen to run. Land the migration
**after** the flag-gated alpha is verified, ideally folded into the next time the
draft engine or error handling needs real work (per the standing recommendation).
P0–P2 are low-risk and independently shippable; P3 is the real work; P4–P5 are
cleanup.
