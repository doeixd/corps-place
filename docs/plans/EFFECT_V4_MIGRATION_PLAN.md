# Effect v4 Migration Plan

Status: **proposed** (Effect v4 is still in beta — treat as a tracked spike, not a deadline-bound migration). Pin to a single beta tag and re-pin deliberately.

## TL;DR

Two independent npm projects use Effect and must migrate in lockstep but typecheck separately:

| Project | `effect` | Separate `@effect/*` packages | Typecheck |
| --- | --- | --- | --- |
| root (`app/`) | `^3.21.2` | `@effect/platform`, `@effect/rpc`, `@effect/sql` | `vp check` / `npm run check` (app only) |
| `sdk/` | `^3.19.14` | `@effect/platform`, `@effect/platform-node`, `@effect/sql`, `@effect/sql-libsql` | `npx tsc --noEmit -p tsconfig.json` (from `sdk/`) |

Scope signals: ~125 source files import `effect`/`@effect/*`; ~178 `Schema.*` occurrences across ~60 files; RPC concentrated in 3 files (`app/rpc/*`); 8 `Context.GenericTag`/`Context.Tag` services in `sdk/src`; a custom `@effect/sql-libsql` ambient `.d.ts` shim. No `FiberRef`/`Runtime<R>`/`Context.Reference` usage in app source — those migration guides mostly don't apply.

The dominant cost centers are: (1) **package re-pinning + import rewrites** (mechanical, large fan-out) and (2) **Schema v4** (semantic, highest risk). RPC and Context.Service are medium, contained.

---

## Why this is non-trivial here

1. **Two lockstep version sets.** v4 ships every ecosystem package under one shared version. We cannot bump `effect` in `app/` without bumping its `@effect/platform`/`@effect/rpc`/`@effect/sql` to the same `4.0.0-beta.x`, and likewise for `sdk/`'s five packages. A partial bump won't typecheck.
2. **Package consolidation changes import paths.** `@effect/rpc`, `@effect/sql`, and `@effect/platform` have **no v4 packages at all** (verified) — they move *into* `effect` under `effect/unstable/*`. Our imports (`@effect/rpc/Rpc`, `@effect/rpc/RpcGroup`, `@effect/sql/SqlClient`, platform HTTP) become `effect/unstable/rpc`, `effect/unstable/sql`, `effect/unstable/http`, etc. Only the *driver*/*platform-binding* packages stay separate (`@effect/sql-libsql`, `@effect/platform-node`) and both have matching betas. So this is a delete-and-rewrite, not a re-pin, for the consolidated three.
3. **`unstable/` namespace churn.** `rpc`, `http`, `httpapi`, `sql`, `schema`, `socket`, `cluster` all live under `effect/unstable/*` and can break in *minor* beta bumps. We touch `rpc`, `http`, `sql`, and `schema`.
4. **Schema v4** is its own migration with behavioral changes (see the Schema guide). 178 occurrences is real surface area.
5. **`Context.Tag`/`Context.GenericTag` → `Context.Service`.** The 8 `sdk/src` services need the new constructor shape. `app/` already uses `Effect.Service`, which is the recommended form and migrates more cleanly.

---

## Phase 0 — Spike & decision gate (do this first, timebox it)

Goal: answer the blocking questions before touching the real tree. Do it in a throwaway worktree.

**Package availability — VERIFIED 2026-06-11 (registry check). Blocker cleared.** Current beta tag is `4.0.0-beta.79` (effect `latest` is still `3.21.3`). Findings:

| Package | v4 beta? | v4 home |
| --- | --- | --- |
| `effect` | `4.0.0-beta.79` | core |
| `@effect/platform-node` | `4.0.0-beta.79` | **stays separate** — re-pin |
| `@effect/sql-libsql` | `4.0.0-beta.79` | **stays separate** — re-pin |
| `@effect/platform` | none (no 4.x published) | **consolidated → `effect/unstable/http*`** |
| `@effect/sql` | none (no 4.x published) | **consolidated → `effect/unstable/sql`** |
| `@effect/rpc` | none (no 4.x published) | **consolidated → `effect/unstable/rpc`** |

So `@effect/sql-libsql` **does** have a matching v4 beta — `sdk/` is not blocked. The three consolidated packages must be *removed* from `package.json` and their imports rewritten to `effect/unstable/*` (Phase 1), not re-pinned.

Remaining Phase 0 tasks:

- [ ] Re-run the registry check at migration time to pick the then-current `4.0.0-beta.N` (the ecosystem ships frequently — beta.79 today).
- [ ] Confirm the v3→v4 rename maps and the Schema v4 guide against the *actual* installed beta (beta APIs drift from docs).
- [ ] Decide migration order: **`sdk/` first or `app/` first.** Recommendation: **`app/` first** — smaller Effect surface, RPC is only 3 files, and `app/` does not depend on `sdk/`'s build output at type level for the Effect parts (`sdk` is consumed as data/services). Confirm that assumption (`app` imports from `@corps-place/sdk`?) before committing.

**Decision gate:** only proceed if all separate packages have matching betas. Otherwise stop and record the blocker.

---

## Phase 1 — Mechanical rename pass (per project)

Run the v3→v4 import/API rename map. These are bulk, low-judgment edits — do them as reviewable, scoped commits.

- [ ] Bump `effect` + all `@effect/*` to the chosen `4.0.0-beta.N` in `package.json` (root and `sdk/`), `npm install`.
- [ ] Apply import-path rewrites from the rename map:
  - `@effect/rpc/Rpc`, `@effect/rpc/RpcGroup` → `effect/unstable/rpc` (`Rpc`, `RpcGroup`) in `app/rpc/directory-rpc.ts`, `prediction-rpc.ts`, `index.ts`. Concretely:
    ```ts
    // v3 (current)
    import * as Rpc from '@effect/rpc/Rpc';
    import * as RpcGroup from '@effect/rpc/RpcGroup';
    // v4 — exact subpath TBD against the installed beta; likely:
    import { Rpc, RpcGroup } from 'effect/unstable/rpc';
    ```
  - `@effect/platform` HTTP imports → `effect/unstable/http` / `effect/unstable/httpapi` where consolidated; keep `@effect/platform-node` (stays separate) but re-pin.
  - `@effect/sql` core imports (e.g. `SqlClient`, used via the `sql` tagged-template across `sdk/src`) → moved to `effect/unstable/sql`. The driver `@effect/sql-libsql` stays a separate package — its `LibsqlClient` import path is unchanged, but it now re-exports/depends on the consolidated `SqlClient`. Verify `import { LibsqlClient } from '@effect/sql-libsql'` and `import * as LibsqlClient from '@effect/sql-libsql/LibsqlClient'` (both forms are used) still resolve.
- [ ] Apply the **`catch*` renamings** (error-handling guide) — grep `catchAll`, `catchTag`, `catchTags`, `catchAllCause`, `catchAllDefect` and rename per the map.
- [ ] Apply **forking** combinator renames if any `Effect.fork*`/`Fiber` combinators are used.
- [ ] Leave a known-broken typecheck at the end of this phase — that's expected; Phase 2/3 fix semantics.

Files with the heaviest `@effect/*` import counts to prioritize: `sdk/src/websiteApi.ts` (24), `sdk/src/relational.ts` (24), `sdk/src/proxy.ts` (11/16), `sdk/src/service.ts`, `sdk/src/testing.ts`, `sdk/src/showScraperAgent.ts`.

---

## Phase 2 — Services: `Context.Tag`/`GenericTag` → `Context.Service`

Per the services migration guide. Affects 8 `sdk/src` files:

- [ ] `cache.ts` (`CacheService`), `service.ts` (`DciApi`), `mediaService.ts` (`MediaService`), `mlService.ts` (`MlApi`), `observability.ts` (`DciObservability`), `prediction.ts` (`PredictService`, uses `Context.Tag` class form), `browserbaseService.ts` (`BrowserbaseService`), `requestSupervisor.ts` (`DciRequestSupervisor`).
- [ ] Convert each to `Context.Service` (new constructor/shape). Verify the corresponding `Layer`/`*Live` wiring still composes. The 7 of these use the `Context.GenericTag` factory form (an `interface` + a separately-built `Layer`); `prediction.ts` uses the `Context.Tag` class form. Both migrate to `Context.Service`:
  ```ts
  // v3 (current — cache.ts, service.ts, mediaService.ts, mlService.ts, observability.ts,
  //      browserbaseService.ts, requestSupervisor.ts)
  export interface CacheService { readonly getSeasons: () => Effect.Effect<...> }
  export const CacheService = Context.GenericTag<CacheService>("CacheService");

  // v3 (current — prediction.ts, class form)
  export class PredictService extends Context.Tag("PredictService")<PredictService, {...}>() {}

  // v4 — Context.Service (confirm exact shape against installed beta)
  export class CacheService extends Context.Service<CacheService>()("CacheService", {
    // either an `effect`/`scoped` factory or `succeed` for the implementation
  }) {}
  ```
  Watch the call sites: `Context.GenericTag` services are consumed as `yield* CacheService` and provided via a hand-built `Layer.effect(CacheService, ...)`. With `Context.Service` the tag and its default layer co-locate — reconcile the existing `*Live` layers (e.g. `DciObservabilityNoop`, `BrowserbaseServiceLive`) rather than duplicating them.
- [ ] `app/` already uses `Effect.Service` (per AGENTS conventions) — verify the v4 `Effect.Service` signature (`accessors`, `dependencies`, `Effect.fn`) is unchanged or adjust. This is the mandated pattern (`/effect-best-practices`), so keep it idiomatic.

(Cause flattening, Scope, Equality, FiberRef, Runtime<R> guides: **no source usage found** — skip, but spot-check after typecheck for transitive surprises.)

---

## Phase 3 — Schema v4 (highest semantic risk)

Per the Schema v4 migration guide. ~178 occurrences across ~60 files; concentrated in `app/rpc/directory-rpc.ts` (7), `app/lib/event-prediction-api.ts` (5), and the many `sdk` ML/backfill scripts (`deduplicateJudges.ts` has 10).

- [ ] Work module-by-module against the Schema guide. Common breakages to watch: `Schema.optional`/`optionalWith` option shape, `Schema.Class`/`TaggedClass`/`TaggedError` field syntax, `transform`/`transformOrFail` signatures, `propertySignature`/`fromKey`, `optionFromNullable`-style combinators, and decoded/encoded type-param ordering.
- [ ] Prioritize **RPC request/response schemas** (`app/rpc/*`) and **server-fn input validation** schemas first — they're the runtime contract surface.
- [ ] Re-validate `Schema.TaggedError` domain errors still pair with the renamed `catchTag`/`catchTags`.
- [ ] The `sdk` ML scripts are numerous but low-traffic; batch them and lean on `tsc` to find breakage rather than reading each.

---

## Phase 4 — RPC definitions (transport not yet wired — smaller than it looks)

**Finding (verified):** `RpcServer`/`RpcClient`/handler-mount/serializer code exists **nowhere** in `app/` — a grep for `RpcServer|RpcClient|HttpRouter|makeProtocol|RpcSerialization|toWebHandler` matches only the two definition files. The RPC layer is defined but **not transported yet** (consistent with the migration being in progress; reads currently go through Fate/loaders). So there is **no live protocol/serialization wiring to migrate** — Phase 4 is just the three definition files.

- [ ] `app/rpc/directory-rpc.ts` / `prediction-rpc.ts`: re-confirm the `RpcGroup.make(...)` + `Rpc.make(name, { payload, success, error })` builder shape and `group.toLayer({ handler... })` under `effect/unstable/rpc`. Handlers use `Effect.fn('Name')(function* (payload) { ... })` — verify `Effect.fn` is unchanged.
- [ ] `app/rpc/index.ts`: layer composition (`DirectoryRpcLive`, `PredictionRpcLive`, + `EventDirectoryService`/`EventPredictionService`) still wires.
- [ ] The `error`/`success` fields are `Schema.*` — they ride along with **Phase 3** (do them together for the RPC files). The hand-written error unions (`Schema.Union(Schema.Struct({ _tag: Schema.Literal(...) }))`) are good candidates to switch to the actual `Schema.TaggedError` classes during this pass.
- [ ] **When the transport is eventually wired** (future work, not this migration): mount under `app/routes/api/*` using the v4 `RpcServer` + an `RpcSerialization` layer and a `RpcClient`. Capture that this is greenfield-on-v4, not a port.

## Phase 5 — SQL / LibSQL

- [ ] Re-pin `@effect/sql-libsql` to `4.0.0-beta.N`; **remove** `@effect/sql` from `package.json` (consolidated into core — `SqlClient` is now `effect/unstable/sql`). `@effect/sql-libsql` has a verified matching beta, so no fallback is needed.
- [ ] **The dominant pattern to validate** is `LibsqlClient.layer({ url })`, repeated in ~20+ entrypoints (every backfill/build/test script: `analyze2025Data.ts`, `applyJudgeBios.ts`, `backfill*.ts`, `buildMlSequences*.ts`, `buildMlRows.ts`, `cacheSqlite.ts`, `testPrediction.ts`, …). Both import forms appear and both must keep resolving:
  ```ts
  import { LibsqlClient } from '@effect/sql-libsql';            // namespace form
  import * as LibsqlClient from '@effect/sql-libsql/LibsqlClient'; // subpath form
  const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });
  ```
  Fix once, then rely on `tsc` to flag the stragglers — the layer constructor signature is the thing most likely to shift.
- [ ] **Re-evaluate the custom ambient shim** `sdk/src/@types/@effect/sql-libsql/index.d.ts`. It currently augments `@effect/sql-libsql/LibsqlClient` to declare `LibsqlClientConfig` (`url`/`authToken`/`table`) and `layer(): Layer<SqlClient.SqlClient>`, importing `SqlClient` from `@effect/sql/SqlClient`. In v4 that import target (`@effect/sql/SqlClient`) **no longer exists** — it must become `effect/unstable/sql/SqlClient` (or wherever the beta exposes it), **or the shim should be deleted outright** if the v4 `@effect/sql-libsql` ships correct types (the shim exists only because v3 types were thin). Deleting is preferred if it compiles without it.
- [ ] Verify `SqlClient` usage in `relational.ts` (24 `@effect/*` imports — the heaviest SQL consumer) and the read-model builders (`sdk/src/readModel/builders/*`) still compiles and runs against `dci-relational.db`.

---

## Phase 6 — Verify & land

- [ ] `app/`: `npm run check` (typecheck), `npm run test`, then `vite dev` smoke (remember: **plain `vite`, not `vp dev`** — vp doesn't mount the Start SSR middleware), hit a few routes + an RPC call.
- [ ] `sdk/`: `npx tsc --noEmit -p tsconfig.json` — **diff against the pre-existing-error baseline**, don't chase all of them. Run one representative Effect entrypoint script (a `--dry-run` ingest or a read-model emit `--dry-run`).
- [ ] Read-model: run `sdk/scripts/emitReadModel.ts --dry-run` and `verifyReadModel.ts` to confirm builders still produce parity.
- [ ] Bundle-size check (v4 advertises ~6.3 KB core / ~15 KB with Schema) — optional, nice signal that tree-shaking landed.
- [ ] Land as a single PR per project (app PR, then sdk PR) so each typecheck gate is clean independently.

---

## Risks & open questions

1. **`@effect/sql-libsql` v4 availability — RESOLVED (cleared 2026-06-11).** A matching `4.0.0-beta.79` exists, so `sdk/` is not blocked. (Note retained: the two projects are separate npm projects with separate typechecks, so they still **do not have to migrate simultaneously** — `app/` can land first.)
2. **`unstable/` churn.** `rpc`/`http`/`sql`/`schema` can break on minor beta bumps. Pin an exact beta; don't use `^`/`~`. Re-pin only deliberately.
3. **Beta API drift from docs.** The rename maps and Schema guide track a moving target — always verify against the *installed* beta, not the prose.
4. **Schema behavioral changes** (not just renames) could silently change decode/encode results for RPC payloads and server-fn validation. The RPC round-trip smoke test is the guard.
5. **`sdk/dist` is stale build output** containing old `Context.Tag` etc. — ignore it; migrate source only and rebuild.

## Recommended sequencing

`app/` migration (Phases 1–4, 6) as one unit → merge → `sdk/` migration (Phases 1–3, 5–6) as a second unit. Do **not** attempt both in one branch: separate typecheck gates make separate PRs the natural, lower-risk path, and it lets `sdk/` wait if `@effect/sql-libsql` lags.

---

## Verified v4 API deltas (measured against `4.0.0-beta.79`, app/ migration in progress)

Empirically confirmed by bumping `app/` and reading the installed `.d.ts` — not from docs.

**Mechanical (done in `app/`, drop-in renames):**

| v3 | v4 | Notes |
| --- | --- | --- |
| `import * as Rpc from '@effect/rpc/Rpc'` / `RpcGroup` | `import { Rpc, RpcGroup } from 'effect/unstable/rpc'` | index re-exports both as namespaces; `RpcServer`/`RpcClient`/`RpcSerialization` also live here |
| `Schema.TaggedError<Self>()(tag, fields)` | `Schema.TaggedErrorClass<Self>()(tag, fields)` | identical call shape. Fixes the cascade of `new MyError({...})` "Expected 0 arguments" errors |
| `Effect.async((resume)=>…)` | `Effect.callback((resume, signal)=>…)` | same shape; gains an `AbortSignal` 2nd arg |
| pkg deps `@effect/platform`,`@effect/rpc`,`@effect/sql` | removed | no v4 versions exist — consolidated into core `effect/unstable/*` |

These took `app/` from **217 → 168** tsc errors.

**Architectural (the remaining ~122 errors — `Effect.Service` is gone):**

v4 has **no `Effect.Service`**. Service definition moves to **`Context.Service<Self, Shape>()(id, { make })`**, which is a *leaner* primitive — it drops three affordances the codebase relies on (and AGENTS.md mandates):

- `effect:` → **`make:`** (the constructor Effect).
- **No `accessors: true`.** The auto-generated static accessors are gone, so every call site `EventDirectoryService.list2026Events(arg)` (TS2339 "Property does not exist") must change to `const svc = yield* EventDirectoryService; svc.list2026Events(arg)` — **unless** we hand-write static accessor wrappers to preserve the existing ~hundreds of call sites.
- **No `.Default` layer.** v4 `ServiceClass` exposes the key + optional `make`; the `Layer` must be built explicitly (was `Service.Default`). All `…Default` references (TS2339) and `dependencies: [...]` arrays need re-expression via `Layer.provide`.
- `Effect.service(key)` exists but is only the **accessor** (`yield*`-equivalent retrieval), not a class builder — easy to mistake for the replacement; it is not.

This is the same shift as the `sdk/` `Context.GenericTag`/`Context.Tag` → `Context.Service` conversion (Phase 2) — so **both projects converge on `Context.Service`**, and the open design question below applies to both.

### DECISION NEEDED — how to re-express the house service pattern in v4

The choice governs the diff size across ~125 files:

- **Option A — preserve call sites.** Keep `Service.method(arg)` working by hand-writing static accessor wrappers on each service class (a small boilerplate block per service). Minimizes churn at the ~hundreds of call sites; keeps AGENTS.md's "accessors" convention alive in spirit. More code per service definition.
- **Option B — idiomatic v4.** Drop accessors; rewrite every call site to `yield* Service` then `svc.method()`. Larger, more invasive diff but matches v4's intended style and AGENTS.md would be updated to match.
- **Option C — thin local helper.** A shared `makeService`/accessor helper that regenerates v3-style static accessors from the shape, applied once. Best churn/idiom balance if it types cleanly against v4 generics (needs a spike).

Recommendation: **Option A or C** to keep the call-site blast radius small, then revisit idiom later. This needs your call before I proceed — it also forces an AGENTS.md update either way.

---

## Appendix — Inventory (grounding for the phases)

Counts captured 2026-06-11; re-grep before starting since the tree moves.

**`package.json` edits**

- root: bump `effect` `^3.21.2`→`4.0.0-beta.N`; bump `@effect/platform-node` (if present transitively, pin); **remove** `@effect/platform`, `@effect/rpc`, `@effect/sql`; rewrite their imports.
- `sdk/`: bump `effect` `^3.19.14`→`4.0.0-beta.N`; bump `@effect/platform-node`, `@effect/sql-libsql`; **remove** `@effect/platform`, `@effect/sql`; rewrite imports.

**Services to convert (Phase 2) — `sdk/src/`**

`cache.ts`, `service.ts`, `mediaService.ts`, `mlService.ts`, `observability.ts`, `browserbaseService.ts`, `requestSupervisor.ts` (all `Context.GenericTag`) + `prediction.ts` (`Context.Tag` class). `app/lib/*` services already use `Effect.Service` — verify, don't rewrite.

**RPC files (Phase 3+4) — `app/rpc/`**

`directory-rpc.ts` (7 `Schema.*`), `prediction-rpc.ts`, `index.ts`. No transport mount exists yet.

**Heaviest `@effect/*` import files (Phase 1 priority)**

`sdk/src/websiteApi.ts` (24), `sdk/src/relational.ts` (24), `sdk/src/proxy.ts` (~16), `sdk/src/service.ts`, `sdk/src/testing.ts`, `sdk/src/showScraperAgent.ts`.

**LibSQL layer call sites (Phase 5)**

~20+ `LibsqlClient.layer({ url })` entrypoints across `sdk/scripts/*` and `sdk/src/buildMl*`; plus the ambient shim `sdk/src/@types/@effect/sql-libsql/index.d.ts` (re-target or delete).

**Schema surface (Phase 3)**

~178 `Schema.*` across ~60 files; hotspots `app/rpc/directory-rpc.ts`, `app/lib/event-prediction-api.ts`, `sdk/scripts/deduplicateJudges.ts` (10).

**Guides that do NOT apply** (no source usage found): FiberRef, `Runtime<R>`, Context.Reference, Cause-flattening, Scope, Equality, forking combinators. Spot-check after the first clean `tsc` for transitive surprises, but don't pre-plan work for them.

**Verification commands**

- `app/`: `npm run check`; `npm run test`; `vite dev` (NOT `vp dev`).
- `sdk/`: `npx tsc --noEmit -p tsconfig.json` (diff vs pre-existing-error baseline); `npx tsx scripts/emitReadModel.ts --dry-run`; `npx tsx scripts/verifyReadModel.ts`.
