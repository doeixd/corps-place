`vp` (Vite+) is the unified CLI — use `vp dev`, `vp check`, `vp build`, etc. `vp check` (and `npm run check`) only runs on `app/`; the `sdk/` directory is ignored and uses its own `npm run check`.

---

**Deployment — how the app actually runs (read `docs/DEPLOYMENT_REALITY.md` for the full picture):**

`docs/DEPLOYMENT_REALITY.md` is the **source of truth** for production deployment, discovered by inspecting the live box (as of 2026-06-12). Where it contradicts older docs (`DEPLOY-legacy-exe.dev.md`, `deploy.ps1`, the Astro `README.md`), it wins — those describe a never-deployed exe.dev/systemd plan and are stale.

`docs/INFRASTRUCTURE.md` is the **higher-level infra/ops map**: the laptop→cloud topology diagram, the read-model delivery pipeline (local A/B hot-swap fed by **R2 object storage** — `scripts/pushData.ts` ↔ `pullData.ts` / the container entrypoint pulls on boot; Turso was retired 2026-06-15), the `dci-relational.db` → Cloudflare R2 **restic** backup system (daily scheduled task + retention), SSH access to the box, and a full **secrets inventory** (everything in the gitignored repo-root `.env`). Read it for anything touching read-model delivery, backups, or credentials.

- **Hosting:** self-hosted **Coolify 4.1.2 + Docker on one VM** (`149.28.121.248`), **not** exe.dev/systemd. Coolify watches the GitHub repo and **builds + deploys on push** from the root `Dockerfile` (build pack = dockerfile; image tag = commit SHA).
- **Two environments, same box:** **prod** = `drumcorps.app` (branch `master`, data `/data/corps-place`); **dev** = `dev.drumcorps.app` (branch `dev`, data `/data/corps-place-dev`). Data dirs are now fully isolated (dev writes no longer contaminate prod).
- **Dev workflow — deploy is git-push-driven, there is no manual upload.** To see a change on **`dev.drumcorps.app`** you must **commit it and push to the `dev` branch on GitHub**. Coolify's webhook fires on the push, matches `dev` to the dev resource, rebuilds the image from the `Dockerfile`, and does the zero-downtime swap — the new code is live once the health check passes (typically a couple minutes for the build). Pushing to **`master`** likewise deploys **prod** (`drumcorps.app`). So the normal loop is: develop locally with plain `vite` (`npm run dev` — *not* `vp dev`, which 404s every route), then `git push origin dev` to preview on `dev.drumcorps.app`, then merge/push to `master` to ship to prod. Nothing deploys until it's pushed to GitHub; local commits alone do nothing. (You *can* force a rebuild without new code via the Coolify API/UI, but the normal path is a branch push.)
- **TLS/routing:** Coolify's bundled **Traefik v3.6** + Let's Encrypt (HTTP-01); ports 80/443 are the only app-facing ingress. App containers expose port 3000 internally only. Health check = `curl GET /` → 200, with a zero-downtime rollout (this is why the Dockerfile installs `curl`).
- **Runtime data:** the SSR server serves **only** from a small read-model SQLite + media-cache SQLite **bind-mounted at `/data`** (`READ_MODEL_DB_URL`, `MEDIA_CACHE_DB_URL`). The serving image has **no tfjs, no model, and no 3.6 GB relational DB** on the request path, and there is **no nightly training cron on the box** (read-model/media-cache DBs are produced offline and placed on the host).
- **Read-model freshness is now pull-from-R2 (Turso retired 2026-06-15).** Both prod and dev serve from their LOCAL read-model A/B files; neither uses Turso. **Prod** (the production Docker image, deploys from `master`) refreshes via its **container entrypoint** (`docker-entrypoint.sh` → `scripts/pullReadModel.mjs`), which pulls the latest read-model from R2 on boot — best-effort, falls back to whatever is in `/data`. So **a prod redeploy/restart = fresh data**; for a no-redeploy refresh run `cd sdk && npm run pull:read-model` on the box. Publishing is `npm run push:data read-model` (merch/season workflows push automatically). **Dev** is different: it runs a **Vite dev server** (deploys from the **`dev`** branch, NOT `master`) and does **not** run the entrypoint — it's refreshed by **`scripts/sync-dev-read-model.sh`** (snapshots prod's active A/B slot → dev's, via a throwaway `alpine` container so the `docker` group suffices; nightly cron 04:15). So to update dev: push to `dev` (e.g. `git push origin master:dev`) for code, and the sync script for data. If a change *looks* deployed but a date-relative section is empty, suspect stale data — pull (prod) or run the sync (dev), don't chase the component.
- **Coolify dashboard:** `https://coolify.drumcorps.app` (also `http://149.28.121.248:8000`). Routed via a manual Traefik dynamic-config file (`/data/coolify/proxy/dynamic/coolify-dashboard.yaml`), **not** Coolify's Instance Domain setting — don't mix the two.
- **Mounts/branches live in Coolify's Postgres** (`coolify-db`, tables `applications`, `local_persistent_volumes`); editing those rows is durable across redeploys, but the UI is the blessed path. A config change only takes effect once the container is **recreated** (Coolify *restart*), not a plain `docker restart`.
- Deploys can be triggered by hand via the Coolify REST API at `http://localhost:8000/api/v1` (Bearer token from Settings → API Tokens; `POST /deploy?uuid=<app>&force=true` to rebuild, `POST /applications/<uuid>/restart` to recreate without a rebuild). See the doc for *restart vs deploy* and the operational runbook. **But you normally don't need the API** — pushing to `master`/`dev` auto-deploys, and you can confirm it from the box without a token (see next bullet).
- **`COOLIFY_API_TOKEN`** is set in the gitignored repo-root `.env` on the box (a full-control Coolify API token). `sdk/scripts/syncMerch.ts --publish <env>` uses it (with `COOLIFY_API_URL`, default `http://localhost:8000`, and `COOLIFY_PROD_APP_UUID`/`COOLIFY_DEV_APP_UUID`) to redeploy the app via the API after pushing the read-model to R2, so the container pulls the new generation on boot. Never commit the token (it lives only in `.env`); rotate it in the dashboard if it leaks. See `docs/MERCH_DEPLOY.md` §6.

- **Confirming a deploy from the box (no token needed).** The on-box file `/tmp/coolify-codex-token` is **not** a usable bearer token — it's leftover psql output containing the token *hash*, so API calls with it 401, and a newline in it makes nginx 400. To check a deploy instead query Coolify's Postgres directly: `docker exec coolify-db psql -U coolify -c "select id,application_id,commit,status,created_at from application_deployment_queues order by id desc limit 6;"` (prod is `application_id=1`, dev `=2`; statuses go `in_progress`→`finished`/`failed`). Then confirm the live container flipped to your commit with `docker ps --format '{{.Names}}\t{{.Image}}' | grep if4odqr` (image tag = deployed commit SHA) and health-check prod via `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: drumcorps.app' https://127.0.0.1/ -k`. A push-triggered build + zero-downtime rollout takes ~1–2 min. If you need a working API token, mint a fresh one in the dashboard.

**Local dev data workflow - what to copy, restore, or publish:**

- **Normal app/frontend local dev does not need the 3.4 GB relational DB.** Clone or pull from GitHub, install deps, run plain npm run dev or vite, and point the app at the small read-model/media-cache files in sdk: READ_MODEL_DB_URL=file:./sdk/read-model.db and MEDIA_CACHE_DB_URL=file:./sdk/media-cache.db. Copy sdk/read-model.db, sdk/read-model.a.db, sdk/read-model.b.db, sdk/read-model.active, and sdk/media-cache.db from the VM or another current checkout when you need fresh local data.
- **Only download or restore sdk/dci-relational.db for data work**: ingestion, scraping, merch sync, read-model emitting, ML/training, schema repair, or anything that writes source data. It is gitignored and too large for normal app iteration.
- **This VM currently has the full source DB** at sdk/dci-relational.db plus current read-model/media-cache artifacts. docs/INFRASTRUCTURE.md still has some older laptop-only wording. In practice, the box-side scripts below treat the VM copy as usable source data.
- **scripts/vm-sync.sh dev or scripts/vm-sync.sh prod** is VM-only. Default mode, --from-runtime, fast-forwards the chosen branch and copies mounted runtime DBs from /data/corps-place or /data/corps-place-dev into sdk for VM-local debugging. It intentionally does **not** sync sdk/dci-relational.db. --to-runtime --apply writes sdk DB artifacts back into /data and is a runtime-data mutation.
- **scripts/backup-relational.sh** is the VM/Linux restic backup path for sdk/dci-relational.db to Cloudflare R2. It uses SQLite .backup into a temp snapshot before running restic, so it is safe against live SQLite/WAL reads. Credentials come from the gitignored repo-root .env.
- **scripts/backup-relational.ps1** is the laptop/Windows restic backup path for the same DB and same R2 repository. Use it before or after meaningful local data-ingest work.
- **Restore the big DB from backup with restic** when a local machine needs source data and copying from the VM is not desired: load the .env restic/AWS variables, then restic restore latest --target restore-dir and move the restored dci-relational.db into sdk.
- **scripts/publish-data.ps1 -Env dev or scripts/publish-data.ps1 -Env prod** is the laptop canonical publish path after local source-data changes: back up sdk/dci-relational.db, emit the read-model, and push it to the selected Turso DB. -IncludeJsonSnapshot also refreshes public/read-model shards. -SkipBackup and -SkipTurso are explicit escape hatches.
- **scripts/publish-read-model.sh dev or scripts/publish-read-model.sh prod** is the VM counterpart: emit from the VM sdk/dci-relational.db and push to the selected Turso DB. Add --restart only when you want the long-running app container to rebuild its embedded replica immediately. A normal deploy or redeploy is the zero-downtime way to pick up the new generation.
- **scripts/sync-dev-read-model.sh** is a VM-only workaround for dev local/stale A/B read-model. It snapshots prod currently served read-model into dev inactive slot and flips read-model.active. Use it when dev code is deployed but date-relative sections disappear from stale data. Once dev has READ_MODEL_REPLICA_ENABLED=1 and consumes its Turso DB, retire this workaround.
- **Do not commit DBs or secrets.** The DB artifacts and .env stay gitignored. The .env inventory is documented in docs/INFRASTRUCTURE.md, but values live outside git.

`sdk/dci-relational.old.db` is the backup of the previous relational db.
`sdk/dci-relational.db` now contains the website cache (formerly `sdk/dci.db`).
`sdk/docs/ingest-scrape-data-generation.md` documents ingest/scrape/data-generation scripts.
`docs/dci_domain.md` documents judging domain rules and caption structure.
Effect SDK conventions: most ingestion/scrape tooling uses Effect + @effect/sql with LibSQL; entrypoints are `npx tsx ...` scripts that wire SqlClient + API layers.
Cache model: API calls are cached in `api_responses`; website recap HTML is cached in `website_recaps` and is re-parsed without re-scraping when needed.
API vs website recaps: the DCI API is the source of truth for competitions/corps/totals, but it no longer includes the same judge/subcaption breakdowns; website recaps are used to recover those fields.
API changes: newer API data is missing legacy event details; we fall back to Wayback Machine snapshots to ingest event metadata when the API lacks it.
New vs old shows: recent shows often require the website scraper for complete recap/judge data; older shows are still present in the API and can be ingested directly.
Timeline notes: the API/recap gaps started in the 2025 season. COVID seasons (2020 and 2021) have limited or atypical data, so expect sparse recaps and inconsistent event coverage.
`sdk/docs/dci-website-scraping.md` documents website scraping scope, storage, and edge cases.
`sdk/docs/dci-api.md` documents the DCI API endpoints, caching, and data limitations.

**May 2026 — api.dci.org decommissioned:** The public DCI API at `api.dci.org` no longer resolves in DNS.

The SDK now provides **three interchangeable DciApi service layers**:

1. **Network** (`sdk/src/client.ts`) — Legacy `api.dci.org` client. Dead. Preserved for historical use or if DCI restores the endpoint.
2. **DB-backed** (`sdk/src/dbBackedApi.ts`) — Reads all data from the relational SQLite tables. This is the **production default** now.
3. **Website scraper** (`sdk/src/websiteApi.ts`) — Hybrid scraper with caching:
   - Tries `admin-ajax.php` (`load_events`, `score_events`) for bulk lists. Works briefly, then blocked.
   - Falls back to **traditional HTML page scraping** for individual server-rendered pages.
   - **Caches all responses**: AJAX → `api_responses` table; recap HTML → `website_recaps` table (7-day TTL).
   - **May 2026 — Cloudflare block**: DCI.org is now behind Cloudflare. Direct Node.js `fetch()` returns a challenge page, so **live scraping of new pages is blocked**. The scraper still serves previously cached data and checks cache before every live fetch.
   - **Result**: Cannot fetch new pages live, but cached data is served reliably.

There is also a **composite layer** (`sdk/src/compositeApi.ts`) that tries sources in order (default: DB → website → network). When a source returns empty or hits a network error, the composite silently moves to the next source.

For 2026+, the DB-backed layer is the only fully reliable source. Use cached data in `website_recaps` and `api_responses`, or consider browser automation for Cloudflare-protected pages.

**Browserbase integration (`sdk/src/browserbaseService.ts`):**

- Provides `BrowserbaseService` as an Effect-TS service wrapping `@browserbasehq/sdk`
- When provided as a layer, the website scraper (`websiteApi.ts`) automatically uses Browserbase for all HTTP fetches, bypassing Cloudflare
- Usage: set `BROWSERBASE_API_KEY` env var, then provide `BrowserbaseServiceLive` to the scraper layer:
  ```typescript
  makeWebsiteScraperWithBrowserbaseLayer();
  ```
- This is the recommended path for fetching new pages live when Cloudflare is active

---

**ReUI / shadcn UI components (frontend, `app/`):**

- `components.json` uses `"style": "base-nova"` and registry `@reui` → `https://reui.io/r/{style}/{name}.json`.
- **Only some components are ReUI-namespaced** (`@reui/badge`, `@reui/data-grid`, `@reui/alert`, ...). The base primitives (`button`, `button-group`, `input`, `checkbox`, `dropdown-menu`, `select`, `label`, `separator`, `skeleton`, `spinner`, `popover`, `table`, `card`) are **plain names** that resolve against the **default shadcn registry** under the `base-nova` style. There is no `@reui/button` — prefixing base components with `@reui/` is what caused the earlier 404s.
- Verify a name exists before installing: `@reui/<name>` → `https://reui.io/r/base-nova/<name>.json` (200/404); base components → `https://ui.shadcn.com/r/styles/base-nova/<name>.json` (`base-nova` is a valid shadcn style).
- Install (base names + @reui names can be mixed in one command):
  ```bash
  npx shadcn@latest add @reui/data-grid @reui/badge @reui/alert button button-group input checkbox dropdown-menu select label separator skeleton spinner popover table card --yes --overwrite
  ```
  `@reui/data-grid` pulls in most base primitives automatically as registryDependencies.
- **Install path gotcha:** the CLI drops ReUI-namespaced files into `src/components/reui/`, but `tsconfig` excludes `src` and `@/*` maps to `app/*`. Move them: `app/components/reui/` (base `ui` components land correctly in `app/components/ui/`). Their imports (`@/lib/utils`, `@/components/ui/...`, `@/components/reui/...`) then resolve.
- Components are **base-ui** based (`@base-ui/react`), not Radix: `DropdownMenuTrigger` uses `render={trigger}` (not `asChild`), and `Select`'s `onValueChange` can emit `null` (coerce it). `data-grid` also needs `@dnd-kit/*` + `@tanstack/react-virtual`.
- Variant names: `Button` has `default | outline | secondary | ghost | destructive | link` (no `primary`). `Alert` has `default | destructive | info | success | warning | invert` (no `appearance` prop). `Badge` has many incl. `secondary`, `*-light`, `*-outline`.
- DataGrid usage: wrap a `useReactTable` instance — `<DataGrid table={table} recordCount={n} tableLayout={{...}}><DataGridContainer><DataGridTable /></DataGridContainer></DataGrid>`, with `DataGridPagination` / `DataGridColumnHeader` / `DataGridColumnVisibility` as helpers. Needs `getPaginationRowModel` for pagination.
- The flagship example consumer is `app/routes/events/2026/$slug/prediction.tsx`.
- **Layout/interaction tokens — reuse, don't hardcode.** Repeated magic numbers and class recipes are centralized so a change happens once: the mobile **bottom nav** + desktop **sidebar** widths are CSS-var spacing tokens (`pb-bottom-nav` / `pl-side-nav` / `w-side-nav`, defined in `app/app.css` `:root` + `@theme inline`, self-stepping across breakpoints — no `md:`/`xl:` needed); the card hover lift+border+shadow and the "View" arrow nudge are the `.card-hover` / `.card-hover-flat` / `.icon-shift` component classes (`app/app.css @layer components`). Shared helpers: `app/lib/rank.ts` (`medalClass`, `ordinal`), `app/lib/format.ts` (`formatScore`, `formatEventDate`), `app/lib/date.ts` (`todayYmd`, `yearOf`, UTC rules). Directory pages share the SSR→hydration handoff via `<HybridCollection>` (`app/components/hybrid-collection.tsx`), and URL-synced filters use the machine + `SearchCodec` + `useSearchSync` pattern.

---

**Frontend conventions & preferences (from `docs/plans/MIGRATION_PLAN.md` — the Astro → TanStack Start migration):**

Stack: TanStack Start (React 19) + SSR/Streaming, Tailwind 4, ReUI + shadcn/ui, Effect TS (server + optional client), `@libsql/client`, oklch CSS-variable theming, Node deploy preset.

- **Architecture is a hybrid:** Effect Services/Layers + **Effect RPC** for mutations / complex logic / internal calls; **Fate** (`@nkzw/fate`) custom source adapter for reads / `useView`. `createServerFn` is thin transport / legacy only. Lives in `app/rpc/` and `app/fate/`. Domain logic stays in `app/lib/` Effect Services — they are the single source of truth.
- **Effect v4 (beta) — the codebase is migrated to `effect@4.0.0-beta.x`.** Conventions (the `/effect-best-practices` skill predates v4 — these v4 deltas override it):
  - **Services use `Context.Service`, not the removed `Effect.Service`.** Pattern: extract the builder as `const makeFooService = Effect.gen(function* () { …; return { method1, … } })`, then `export class FooService extends Context.Service<FooService, Effect.Success<typeof makeFooService>>()("FooService") {}` and `export const FooServiceLive = Layer.effect(FooService, makeFooService)`. v4 has **no auto-`accessors`, no `.Default`, no `dependencies:`** — call sites do `const svc = yield* FooService; svc.method(arg)` (or `Effect.flatMap(FooService, (s) => s.method(arg))`); former `dependencies` become `Layer.provide([…Live])` on the `*Live` layer. Keep `Effect.fn("Name")` on every public method.
  - **Schema/Effect renames:** `Schema.TaggedError`→`Schema.TaggedErrorClass`; `Schema.Literal(a,b,…)`→`Schema.Literals([…])`; `Schema.Union(a,b)`→`Schema.Union([…])`; `Schema.Record({key,value})`→`Schema.Record(key,value)`; `Schema.Schema<A,I>`→`Schema.Codec<A,I>`; `decodeUnknown`/`encode`→`SchemaParser.decodeUnknownEffect`/`encodeEffect` (+ `decodeUnknownSync` lives on `SchemaParser`). `Effect.catchAll`→`Effect.catch`; `Effect.either`→`Effect.result` (Result `_tag` `Failure`/`Success`, `.failure`/`.success`); `Effect.async`→`Effect.callback`. `effect/Either`→`effect/Result`. SQL: `@effect/sql/*`→`effect/unstable/sql/*`, RPC `@effect/rpc/*`→`effect/unstable/rpc`, platform HTTP→`effect/unstable/http/*`; `sql<Row>` now returns `Row[]` (don't write `sql<Row[]>`).
  - **`sdk/src/schemaCompat.ts`** reimplements the removed v3 `Schema.optionalWith` (nullable + default) and variadic `Schema.Union` faithfully — prefer those helpers over rewriting decode semantics by hand.
  - Still mandatory: `Schema.TaggedErrorClass` per domain error + `catchTag`/`catchTags`; `Effect.log` not `console.log`; **no `Effect.runPromise`/`runSync` inside service bodies** (only at boundaries — Fate resolvers, XState actions, server-fn handlers — and even there delegate to Services). Effect Language Server is enabled in `tsconfig.json` (use workspace TS version). Full migration notes: `docs/plans/EFFECT_V4_MIGRATION_PLAN.md`.
- **State management = XState v5 + Effect.** Every system logic is a state machine. Use `setup({ types, actions }).createMachine(...)`. Each action delegates to an Effect Service; async actions use `self.send(...)` for loading→success|error. Machines live in `app/machines/`. React components are dumb: only (1) render from `snapshot.value`/`snapshot.context` and (2) `send` events — no business logic, no `useState` for loading/error, no direct service calls.
- **React Compiler is on** — write components naturally; do **not** add manual `useMemo`/`useCallback`/`React.memo`. Follow Rules of React (compiler errors on violations); `use no memo` to opt out.
- **Predicates:** centralize all boolean logic, flags, guards, conditions via `effect/Predicate`, defined once in `app/predicates/*.ts` and reused across machine guards, `<Show>`/`<Match>`, and services. Prefer `Predicate.struct`/`Predicate.tuple` over `&&`/`||` chains.
- **Pattern matching:** default to `effect/Match` for any non-trivial / exhaustive conditional (domain types, errors, modes, machine states); keep `jotai-solid-api` for lightweight presentational control flow.
- **Control flow components:** use `<Show>` / `<For>` (and acceptably `<Switch>`/`<Match>`) from `jotai-solid-api` instead of nested ternaries / `&&` / `.map()` for conditionals and lists in JSX.
- **Other defaults:** Motion (`motion/react`) for animation (drive `AnimatePresence`/variants off `snapshot.matches`); Hugeicons for icons — via **unplugin-icons** + Iconify (`@iconify-json/hugeicons`), imported as `~icons/hugeicons/<kebab-name>` (e.g. `~icons/hugeicons/refresh`) and rendered through the `<Icon icon={X} size="sm" />` wrapper (`app/components/icon.tsx`). They are real SVG components (svgr `jsx` compiler — needs `@svgr/core` + `@svgr/plugin-jsx`); stroke width is baked at 1.5. The old `@hugeicons/react` runtime + per-icon data imports were removed; Unpic (`@unpic/react`) for images; Effect Schema for runtime validation of server-fn inputs / API responses / forms; Better Auth for auth (deferred).
- Live progress tracker is `docs/plans/MIGRATION_PROGRESS.md`; the full plan/rationale is `docs/plans/MIGRATION_PLAN.md`.

---

**React best practices — `useEffect` is a code smell (treat it as a last resort):**

Most `useEffect`s in this codebase are bugs waiting to happen — they re-introduce loading flashes, StrictMode double-fetch races, and state that drifts out of sync. Before writing one, find the layer that already owns the concern. **An effect is only the right tool for true synchronization with an *external* system** (a non-React subscription, the DOM, a browser API like `localStorage`/`matchMedia`/`ResizeObserver`, a `requestAnimationFrame`). Everything below has a better home:

- **Data fetching → route `loader`, never a client effect.** This is the rule, restated because it's the most common violation: a mount `useEffect` that fetches means a spinner on every visit, no SSR, and a StrictMode double-fire. Put it in the route `loader` (SSR'd + preloaded-on-intent) and read it with `Route.useLoaderData()`. *Concrete win:* the full-recap preload was a `useEffect` + `useRef` (StrictMode dedup) + two `useState`s with an `idle/loading/error/ready` machine — it shipped a real "stuck on loading forever" bug (cleanup cancelled the only in-flight fetch while the ref blocked the remount from re-firing). Moving the fetch into the route `loader` (always preload full recap for past seasons) **deleted all of it** and made the loading state structurally impossible. If you ever need lazy/on-demand client data, reach for an XState actor (`fromPromise`) or a small dedicated hook — not a raw effect.
- **Async/stateful logic → XState machine.** Loading/error/success, retries, cancellation, sequencing — model it as states + an `invoke`d actor (`fromPromise`), not `useState('idle'|'loading'|…)` + effects. Components stay dumb (render from `snapshot`, `send` events). See the State-management bullet above.
- **Derived values → compute during render, don't sync with an effect.** If a value can be calculated from props/context/snapshot, just calculate it inline (or in a pure selector — `event-filtering.ts`, `judge-profile.ts`). Never `useState` + `useEffect` to mirror a prop into state; that's the classic off-by-one-render desync. React Compiler is on, so you don't even need `useMemo` for the cost.
- **URL ⇄ machine sync → `useSearchSync`, not hand-rolled effects.** Two-way search-param sync is solved (`app/lib/use-search-sync.ts` + a `SearchCodec`). Hand-rolled hydrate/mirror effects race each other and flip-flop on refresh (we've fixed this exact bug twice — see the URL-sync bullet below).
- **Data-driven defaults → machine context init / on-data events, not a post-load effect.** A default that depends on loaded data belongs in the machine (gated by a `*Touched` flag), never a `useEffect` that derives it and writes it back (that races the URL sync).
- **Event-handler work → do it in the handler, not in an effect reacting to the state change.** If something should happen *because the user clicked*, put it in `onClick`/the `send`, not an effect watching the resulting state.
- **If you must write an effect:** key it correctly, return a cleanup, and remember **StrictMode runs mount→unmount→remount in dev** — any ref-based dedup must reset on cleanup or the remount short-circuits and you lose the work. This footgun alone is a reason to prefer loaders/actors that handle it for you.

Quick smell test before adding `useEffect`: *"Is this synchronizing with something outside React?"* If no → it belongs in a loader, a machine, a selector, `useSearchSync`, or an event handler.

**React 19 concurrent + async features — use them; don't hand-roll their jobs:**

This is React 19 (Compiler on). When you reach for `useState` + an `async` handler + `try/finally` + a manual `loading` flag, stop — a built-in already models it, with less code and correct pending/error/transition semantics. Pick by what you're doing:

- **Async mutation/action with pending state → `useActionState`, not `useState`+`try/finally`.** It owns the result state *and* an `isPending` flag and runs the work in a transition. Wire it to `<form action={dispatch}>` (progressive-enhancement, declarative) or call the dispatcher from a handler. *Concrete win:* the `/merch` "load more" pager was three `useState`s (`loaded`/`page`/`loadingMore`) + an `async` fn with `try/finally`; it collapsed to one `useActionState((prev) => ({...append next page...}))` whose third return *is* the pending flag (`app/routes/merch/index.tsx`). The reducer reads its `prev` argument, so there's no stale-closure bug.
- **External store (incl. `localStorage`) → `useSyncExternalStore`, never `useEffect`+`useState` to mirror it.** Provide a `getServerSnapshot` that returns a **referentially-stable** SSR value so the hydration render matches the server and React swaps in the live value right after — no mismatch, no effect. *Concrete win:* the cart hydrated via `useEffect(() => hydrateCart(), [])`; it's now `useCartItems()` = `useSyncExternalStore(subscribe, () => store.getSnapshot().context.items, () => SERVER_ITEMS)` with the store self-hydrating once at module load on the client (`app/stores/cart-store.ts`). XState stores already expose `subscribe`/`getSnapshot`, so this is a 3-line hook. (`@xstate/react`'s `useSelector` is fine for client-only widgets like `theme-toggle`; use the explicit `getServerSnapshot` form when the value is SSR'd.)
- **Optimistic UI → `useOptimistic`.** For a mutation whose result you can predict (toggle, add-to-list, qty change), render the optimistic value immediately and let it reconcile when the action resolves — don't juggle a temp `useState` + rollback by hand.
- **Non-urgent updates → `useTransition`/`startTransition`.** Wrap state updates that trigger expensive re-renders (large filter/sort recompute, tab switches) so typing/clicks stay responsive and you get `isPending` for affordances. `useActionState` already transitions its action; reach for `useTransition` directly for non-action updates.
- **Reading a resource/promise/context conditionally → `use`.** `use(promise)` (with Suspense) or `use(Context)` — `use` may be called conditionally/in loops, unlike other hooks. Prefer the route `loader` for page data; use `use()` for genuinely deferred/streamed values, not as a fetch-on-render shortcut.
- **The rare effect that reads latest props without re-subscribing → `useEffectEvent`.** When you *do* have a legitimate external-sync effect (a subscription) but it shouldn't re-run just because a callback/prop it calls changed, extract that non-reactive part into a `useEffectEvent` so the effect's deps stay minimal. This is for trimming a justified effect — not a license to add one.
- **Affordances are state, not vibes.** Drive `disabled`, "Loading…", spinners, and aria-busy from the real `isPending`/snapshot flags these hooks give you — never a separate boolean you set/unset by hand.

The through-line: **state lives at the edges (loaders, XState machines, external stores, actions); components render it and emit events.** If you're imperatively sequencing async + flipping flags inside a component, you've picked the wrong tool.

---

**Fate data layer (`@nkzw/fate` + `react-fate`) — reads only:**

Fate is the normalized read path (Relay-style views + masking). Mutations/complex work stay on Effect RPC + Services. **Fate is alpha** — pin behavior to what's verified here. Files live in `app/fate/`.

- **Source = custom adapter over Effect (NOT direct DB).** Effect Services remain the single source of truth. We reuse Fate's Prisma adapter (`createPrismaSourceAdapter`) but feed it a **delegate** (`{ findMany, findUnique }`) backed by an Effect Service — see `app/fate/sources.ts`. The delegate calls the service via `Effect.runPromise` (the one allowed transport-boundary `runPromise`) and projects `id` from the entity's natural key (events: `id = slug`). Fate handles all selection-plan/registry/masking; the delegate may ignore the `select` arg (Fate masks the result to the view anyway).
- **Server pieces:** `context.ts` (`AppContext = { request }`), `views.ts` (`dataView<Node>('Type')({...})` + `Root = { events: list(view, { orderBy }) }`; every entity needs a stable `id`), `sources.ts` (the Effect-backed adapter), `server.ts` (`createFateServer` + `createFateFetchHandler`).
- **GOTCHAs (cost real time — don't relearn):**
  - **Do NOT pass an explicit generic to `createFateServer`** — one type arg defeats inference of Roots/Lists and collapses the API type. Let Context infer from the `context` callback's return.
  - The generated client imports a type literally named **`Event`** from the server module — server.ts re-exports `EventEntity as Event`. New entities need the same `as <TypeName>` re-export.
  - Fate server-side files (`views.ts`/`sources.ts`/`server.ts`) must use **relative imports**, not `@/` — the codegen module runner does not apply Vite aliases.
- **Codegen + transport:** the `react-fate/vite` plugin (`fate({ module: './app/fate/server.ts', transport: 'native', generatedFile: './app/fate/__generated__/fate.ts' })`) generates the real `createFateClient` + typed roots. `app/fate/client.ts` instantiates it (`url: '/api/fate'`, `liveUrl: '/api/fate/live'`) and re-exports hooks + `FateProvider`. The handler is mounted via server routes `app/routes/api/fate.ts` + `fate.live.ts`; `<FateProvider client={fateClient}>` wraps the app in `__root.tsx`.
- **Client usage (Relay-style):** define a client `view<Entity>()({ field: true, ... })`. A "many" field is **flat OR connection by request shape** (no server change): `list: plainView` → flat `ReadonlyArray<ViewRef>` read with `<For>`; `list: ConnectionView` (`{ args, items: { node }, pagination }`) → connection read with `useListView` (gives `loadNext`/`loadPrevious`). Parent gets **refs**; each leaf unmasks via `useView(NodeView, node)`. Prefer the composed **`useConnection(rootKey, connectionView, args?)`** hook (`app/fate/use-connection.ts`) which fuses `useRequest` + `useListView` into one fully-typed call. `app/routes/fate-events.tsx` is the reference consumer.
- **GOTCHA:** `jotai-solid-api`'s `<Show when={fn}>` _invokes_ a function `when` (accessor semantics). Never pass a function (e.g. `loadNext`) to `when` — pass `Boolean(fn)`.
- **Status:** server adapter + codegen are proven (typecheck + a direct `sources.resolveConnection` smoke test); the full HTTP round-trip is unverified until the pre-existing vinxi/build breakage (503 on all routes / `path.replace is not a function`) is fixed.

---

**TanStack Start — performance, loaders & dev gotchas (read before touching pages):**

- **`vp dev` does NOT serve routes — use plain `vite`.** vite-plus (`vp dev`/`vp build`/`vp preview`) does not install the `@tanstack/react-start-plugin` SSR middleware, so its dev server returns `404 Cannot GET /` (finalhandler default) on **every** route. The `dev`/`build`/`preview` npm scripts are therefore plain `vite …`; `vp` is kept only for `check`/`lint`/`fmt`/`test`. If every route 404s, this is why — it's not the routes or the `app/` dir (plain `vite dev` serves them 200).
- **Fetch data in route `loader`s, not client `useEffect`.** Client-only fetching (machine `useEffect` → `FETCH` on mount) means a spinner on every visit and no SSR. Instead: `createFileRoute(...)({ loader: async () => ({ events: await getHybridEventDirectory() }), staleTime: 60_000, component })`. The loader runs server-side during SSR **and** preloads on intent (`defaultPreload: 'intent'` in `router.tsx`), so navigation is usually instant. `app/routes/events/2026/index.tsx` is the reference.
- **Seed XState machines from loader data.** Give the machine a `types.input` and `context: ({ input }) => ({ events: input?.events ?? [], ... })`, then `useMachine(machine, { input: { events: Route.useLoaderData().events } })`. The machine starts in `idle` already populated — no mount fetch, no first-load spinner. Manual refresh still goes through the machine's actor.
- **Caching:** set `staleTime` per route (or bump `defaultPreloadStaleTime`, currently `0` in `router.tsx`) so preloaded/visited loader data is reused instead of refetched.
- **Avoid FOUC from Motion:** server-rendered content must not start hidden then fade in — pass `initial={false}` (not `initial="hidden"`) on the top-level `motion` element of SSR'd lists. Children inherit, so `whileHover`/`layout`/filter animations still work; only the blank-then-fade flash is removed. (Plan's SSR guidance.)
- **Delayed spinner:** use `useDelayedFlag(active, 250)` (`app/hooks/use-delayed-flag.ts`) so quick loads/refreshes don't flash a spinner; and prefer keeping a stale list on screen during refresh (only show the spinner when there's genuinely nothing to display yet).
- **Always set a `defaultNotFoundComponent`** on the router (`app/components/not-found.tsx`) — otherwise unmatched paths (favicon, typos) log a warning and render TanStack's generic `<div>Not Found</div>`.
- **Dates from the SDK are UTC ISO at midnight Z** (`...T00:00:00.000Z`). Format with `timeZone: 'UTC'` (see `app/lib/format.ts`) or the calendar date shifts a day in negative-offset timezones.
- **Design-token gotcha (`app.css`):** `@theme { --color-*: initial }` wipes the entire Tailwind default palette, so any semantic var defined as `var(--color-emerald-500)` etc. resolves to nothing (badges/alerts render monochrome/black). Define `--success`/`--info`/`--warning`/`--destructive-foreground`/`--invert` (+ `-foreground`) with **oklch literals**. `-foreground` is the dark text used by `-light`/`-outline` badge/alert variants on a tinted bg → keep it dark in light mode, light in dark mode.

---

**Patterns established in practice (corps / events / prediction work) — prefer these:**

- **XState ↔ URL sync → use `useSearchSync` (`app/lib/use-search-sync.ts`).** A typed two-way bridge: a `SearchCodec` (`encode`/`decode`) + a single generic `SYNC` event the machine applies (an `assign` merge). Seed the machine `input` from `codec.decode(search)` so initial context matches the URL (no mount-time clobber/loop); pass `ready` to gate hydration when context depends on async data (e.g. prediction `baseRecap`). Codecs live next to their machine (`eventFilterSearchCodec`, `predictionSearchCodec`). **Do not** hand-roll hydrate/mirror effects.
  - **Codec ⇄ `validateSearch` must agree on types.** The route's `validateSearch` coerces query values (`group`, `ranges`, `recap`, …) to **booleans/literals**, so a `decode` that compares against the *string* `'true'` silently never matches (this is what broke score-table grouping). Read **and** write the same type both ways; keep `encode`/`decode` symmetric and omit defaults, or the machine→URL mirror churns/loops.
  - **Data-driven defaults belong in the machine, not a post-load effect.** A default that depends on loaded data (e.g. `groupByClass` = grouped when the recap spans >1 class) is computed in the machine's context init / on data arrival, gated by a `*Touched` flag so only *explicit* user choices persist to the URL. A `useEffect` that derives a default and writes it back to the URL races the sync hook and flip-flops on refresh.
- **Shared list filter/sort:** filter _state_ in an XState machine (`eventFilterMachine`), _derivation_ in a pure selector (`app/lib/event-filtering.ts` → `selectEvents`/`availableSeasons`) built from `effect/Predicate` refinements (`Predicate.and`, reusing `app/predicates/*`) + `effect/Match` for ordering. Reuse the selector across pages even when one keeps URL-as-source.
- **Data-driven config over ternaries:** select variant/icon/style from a keyed map, not `if`/ternary ladders — e.g. `CATEGORY_BADGE` (`class-badge.tsx`), `READINESS_CHIPS`. Derive the category once (`divisionCategory`) so spelling variants collapse.
- **Extract shared presentational components** instead of duplicating markup: `EventCard`/`EventCardGrid`, `CorpsNameCell`, `ClassBadge` (clickable → `/corps?cls=`, with a `noLink` opt-out when nested in another link).
- **Display-vs-data:** normalize for _display only_ (e.g. division label grouping) — never rewrite columns the ML pipeline consumes (`corps.division_name` is a model feature).
- **Charts = recharts.** Guard `ResponsiveContainer` with a mounted check (render a fixed-height placeholder during SSR) to avoid the width/height `-1` warning.

**Scraping / ingest (the corps pipeline — `sdk/CORPS_SCRAPING_PLAN.md`):**

- **Pipeline shape:** scrape → **archive** (raw HTML + parsed JSON + `scraped_at`, full history = _time travel_) → **pure parsers** (cheerio, re-runnable over the archive) → **coalescing + guardrailed ingest**. The corps archive table `corps_page_scrapes` mirrors `event_page_scrapes` / `website_score_lists`.
- **Fetch via Browserbase by default** when `BROWSERBASE_API_KEY` is set (Cloudflare bypass), **cache-by-default** with TTL. The composite default is now **`db → website`** (the network `api.dci.org` source is dead — dropped from defaults).
- **Coalescing upsert:** scraped non-null wins, a missing scraped field **never** nulls out existing data; guardrails reject placeholder garbage (`---`, `00000`) and keep `address` overwrites _enrichment-only_; the **DCI site is authoritative for the displayed hometown** (`display_city`/`city`/`state`). Always offer `--dry-run` reporting `changes` vs `held` before writing.
- **Corps identity:** resolution via `resolveExistingCorpsKey` / `matchExistingCorpsKey`, which match by **name-normalization** (strips `the`/`corps`/`drum`/`bugle`/`&`/`.`, then optionally city). ⚠️ The `corps_aliases` table is **not currently wired into this path** (see "Databases & schema robustness" below) — adding rows there has no effect on matching yet. Re-link existing rows with `npx tsx scripts/ingestLineupsFromScrapes.ts`.
- **Orchestrator:** `sdk/scripts/scrapeCorps.ts` (`--apply` / `--refresh` / `--slug`), wired into `seasonUpdateWorkflow` (skippable via `--skip-corps`).

---

**Databases & schema robustness (`sdk/*.db`) — read before any DB-writing script:**

- **The DB files (all SQLite/LibSQL, in `sdk/`):**
  - **`dci-relational.db`** — the live, authoritative relational DB (~2.5 GB). The SDK DB-backed `DciApi` and the read-model emit read this; the **app** reads it directly only in dev/fallback — **in production the app serves from the read-model** built from it (see "Read-model" below). Holds everything: `corps`, `events`, `event_lineup_entries`, `competitions`/scores, the scrape archives (`event_page_scrapes`, `corps_page_scrapes`, `website_recaps`, `api_responses`), ML sequence/feature tables, etc.
  - **`media-cache.db`** — image byte cache (`media_cache(url PK, content_type, bytes BLOB, byte_length, fetched_at)`). **Shared interaction point:** written by both the app (`app/lib/media-cache.ts` `getOrFetchMedia`, served via `/api/media?u=`) and the SDK (`sdk/src/mediaService.ts` `MediaService`). Asset **metadata** lives separately in `media_assets` (in `dci-relational.db`). A cache hit is served regardless of host; only fetch-on-miss is host-allowlisted (SSRF guard).
  - **`dci.db` / `dci-relational.old.db`** — older/stale snapshots (no `corps_page_scrapes`, missing newer lineup columns). Usable as rough references, **not** clean restore sources for the current schema.
  - **`dci-relational - Copy.db`, `dci-scores.db`, `corps.db`, `event-progress.db`** — assorted copies/auxiliaries; verify contents before trusting any as a backup.
- **⚠️ Schema desync hazard — the working-tree `relational.ts` is OLDER than the live DB.** Several tables in `dci-relational.db` have columns that were added by migration/backfill scripts and are **not** reflected in `ensureRelationalSchema`'s `CREATE TABLE` statements (e.g. `event_lineup_entries.{performance_order,is_non_performance,is_exhibition}`, `event_participants.performance_order`). Likewise, helper code referenced symbols (`upsertCorpsPageScrape`, `DIRECTORY_SCRAPE_SLUG`, …) that had gone missing from `relational.ts`. **Treat the live DB schema — not `relational.ts` — as the source of truth;** check `.schema <table>` before assuming column shape.
- **⚠️ `ensureRelationalSchema` WAS destructive — now fixed; never reintroduce the DROPs.** It used to run `DROP TABLE IF EXISTS` on `event_venues` / `event_participants` / `event_lineup_entries` / `event_group_types` then recreate them empty (from the older schema). Running any script that called it (e.g. `scrapeCorps.ts`, the discovery orchestrator) against the live DB **wiped those tables** and reverted their schema. The DROPs have been removed (CREATEs are all `IF NOT EXISTS`), so schema-ensure is now idempotent/non-destructive. **Do not re-add table DROPs to `ensureRelationalSchema`;** if you ever need a reset, gate it behind an explicit, separate `--reset` path.
- **Robustness / recovery — the volatile event tables are rebuildable from the scrape archive.** `event_lineup_entries`, `event_participants`, `event_venues`, `event_group_types` are *derived* data; the durable source is **`event_page_scrapes`** (raw event HTML + `lineup_json`). To rebuild after loss/corruption (in order): `npx tsx scripts/ingestLineupsFromScrapes.ts` (re-derives lineup entries + participants via `upsertEventPageScrape`), then the backfills `backfillEventLineupIsNonPerformance.ts`, `backfillPerformanceOrder.ts`, `backfillEventVenues.ts`, `backfillEventGroupTypes.ts`. None of these are destructive. Note `is_non_performance` is **keyword-derived** (not authoritative) — a rebuild reproduces the heuristic, not any manual corrections.
- **Discovery/archive tables are durable** — `corps_page_scrapes` (raw + parsed corps HTML, full `scraped_at` history), `corps_class_history`, `event_page_scrapes`, `website_recaps`, `api_responses`. Prefer re-parsing these over re-fetching (Cloudflare/Browserbase cost).
- **`corps_aliases` is NOT currently consulted by code** (despite the alias note above): no `.ts` reads it, and `resolveExistingCorpsKey`/`matchExistingCorpsKey` resolve by name-normalization (which strips `the`/`corps`/`drum`/`bugle`/`&`/`.`), not via that table. Rows in `corps_aliases` are forward-looking until something wires them into resolution. (`KNOWN_CORPS_ALIASES` does not exist in `relational.ts`.)
- **General rule:** before running a DB-writing SDK script against `dci-relational.db`, (1) grep it for `ensureRelationalSchema` / `DROP` / bulk `DELETE`, (2) prefer `--dry-run`, and (3) treat a 2.5 GB binary as effectively un-backed-up — there is no cheap snapshot.

**Read-model — the production read path (`docs/plans/READ_MODEL_PLAN.md`):**

- **Prod serves page data from the precomputed read-model, not the live relational DB.** App read services go through `app/lib/read-model-db.ts` (`getReadModelClient` / `readModelEnabled`): when `READ_MODEL_DB_URL` is set (production) they read the small `rm_*` tables; with it **unset** (local `vite` dev) they **fall back** to building from `dci-relational.db`. The builders in `sdk/src/readModel/builders/*` are the single source of truth — shared by the live fallback *and* the emitter so the two can't drift.
- **Emit:** `sdk/scripts/emitReadModel.ts` (run from `sdk/`; supports `--dry-run`, `--only <section>`) rebuilds `rm_*` from `dci-relational.db`. **Bump `SCHEMA_VERSION`** on any `rm_*` schema change. `scripts/verifyReadModel.ts` asserts builder-vs-emitted parity against the active build.
- **Zero-downtime A/B hot-swap.** `READ_MODEL_DB_URL` is a *base path* (`file:.../read-model.db`); the emit never overwrites the in-use file. It publishes into the **inactive** of two slots (`read-model.a.db` / `.b.db`) and atomically flips a pointer file (`read-model.active` → `a`/`b`). The long-lived server polls the pointer (~5 s) and reconnects to the new slot — **no restart, no downtime**, and it sidesteps the Windows "can't rename over an open file" problem. So a **re-emit is safe any time**, not just during a deploy. All slot files + pointer are gitignored (`sdk/read-model*`).
- The live server (`node .output/server/index.mjs` inside the Coolify app container, fronted by Traefik — **not** the stale `proxy.mjs`/`deploy.ps1` tunnel) holds the active slot open; the pointer flip is how a running server picks up fresh data without a bounce. **The A/B-slot local file is the ONLY read path** (Turso/embedded-replica retired 2026-06-15). `READ_MODEL_REPLICA_ENABLED` and the `READ_MODEL_SYNC_URL*`/`READ_MODEL_AUTH_TOKEN*` env vars are dead — `read-model-db.ts` only reads the local slot now.
- **Distribution is R2 → local file.** The read-model is pushed to Cloudflare R2 (`corps-place` bucket, `corps-data/read-model/` prefix) by `scripts/pushData.ts` (`npm run push:data read-model`). The serving container's **entrypoint** (`docker-entrypoint.sh` → `scripts/pullReadModel.mjs`) pulls it into `/data` on boot — into the inactive A/B slot, then flips the pointer — best-effort, so a pull failure just serves the on-disk files and never blocks boot. **So: publish (push to R2) → deploy/restart, and the container has fresh data.** No replica generations, no silent stale-sync trap.
- **Deploy healthcheck is `curl /` (Coolify, ~10s timeout / 15s start-period in `coolify-db.applications`).** The entrypoint pull is `timeout 120` and best-effort, so it can't hang boot past the healthcheck. Pushing to R2 during a deploy is harmless (the pull just reads whatever the current object is).
- **Canonical data-update path = push to R2.** On the box: `cd sdk && npm run push:data read-model` (emit first if the relational DB changed: `npx tsx scripts/emitReadModel.ts`), then redeploy/restart the app (e.g. via the Coolify API, see `syncMerch.ts`) so the entrypoint pulls it — or, for no-redeploy refresh, `npm run pull:read-model` on the box (hot-swaps the inactive slot + flips the pointer). `push:data`/`pull:data` also handle `relational` and `media-cache` (or `all`). Both prod and dev use this same flow — no env asymmetry anymore.
- **Recap detail is available** beyond the compact 8-subcaption table: `judge_scores`, `subcaption_scores` (Rep/Perf/Cont/Achv per judge), and `category_scores` (incl. **Penalties**) feed `buildEventFullRecap` → `rm_event_full_recap` (`readEventFullRecap`), surfaced lazily behind `?recap=full`.
- **Data-quality & read-model gotchas: read `docs/DATA_QUALITY_NOTES.md`** before touching event↔score matching, corps appearance cards, the emit, merch ingest, or the media-cache proxy. Covers the two slug namespaces (`events` vs `competitions`) + `event_to_competition` matcher and the multi-night sibling-event cross-link bug; event_id-vs-slug keying of appearance results; "is the `rm_*` table actually emitted?"; merch dedup/link-only/bad-store patterns; the media-cache bind mount + image ingest/proxy rules; and the `<Show>` eager-children SSR trap.

**Working style:**

- `createServerFn` is thin transport; business logic lives in Effect Services (`app/lib/*`, `sdk/src/*`). Use `effect/Match` + `effect/Predicate` for conditionals, including inside XState actions/guards.
- Type-check: `vp check` / `npm run check` cover **`app/` only**; for `sdk/` run `npx tsc --noEmit -p tsconfig.json` (it has pre-existing errors — diff against baseline, don't chase them all).
- For data-affecting or outward-facing actions (DB writes, scrapes, deploys): **dry-run / diff first**, never overwrite curated data blindly, and report outcomes faithfully. The user prefers to confirm UI results themselves — don't auto-launch a browser to "verify".
- **Commit frequently.** Make small, focused commits as you go rather than batching a large change into one. Commit each logical unit of work once it's coherent (a fix, a refactor, a new component) with a clear message — don't let uncommitted work pile up. Frequent commits keep the history reviewable, make `git` bisect/revert useful, and (since deploys are git-push-driven) keep what's shippable in small, well-described increments. Commit before starting a risky or large change so there's a clean point to return to.
- **You are probably running in a worktree-using harness** (an agent harness that runs you in a dedicated git worktree, not the user's primary checkout). Because of that, committing frequently matters even more: your work lives on a separate branch/worktree, and small, well-described commits are how it stays visible, reviewable, and mergeable back. Don't assume your uncommitted working tree is what the user sees — commit so the work actually surfaces. Check `git status`/`git worktree list` if you're unsure which branch/worktree you're on before committing or pushing.

---

**`effect/Match` over ternaries — reach for it often.**

When a conditional picks an output from an input (especially a domain type, discriminated union, error, mode, or machine state), prefer `effect/Match` instead of `?:` chains or `if`/`else`. It's more readable, composable, and gives compile-time exhaustiveness.

```ts
import { Match } from 'effect';

const f = Match.type<Input>().pipe(Match.when(predicateOrPattern, onTrue), Match.orElse(onFalse));
```

For a type guard/refinement, `Match.when` narrows the true branch and `Match.orElse` receives the remaining type:

```ts
type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; size: number };

const isCircle = (s: Shape): s is Extract<Shape, { kind: 'circle' }> => s.kind === 'circle';

const describe = Match.type<Shape>().pipe(
  Match.when(isCircle, (circle) => `circle ${circle.radius}`),
  Match.orElse((square) => `square ${square.size}`)
);
```

Prefer object patterns + `Match.exhaustive` for discriminated unions (compile error if a case is added later):

```ts
const describe = Match.type<Shape>().pipe(
  Match.when({ kind: 'circle' }, (circle) => `circle ${circle.radius}`),
  Match.when({ kind: 'square' }, (square) => `square ${square.size}`),
  Match.exhaustive
);
```

API cheat-sheet (don't reinvent these):

- `Match.type<I>()` — reusable `(input: I) => output` matcher.
- `Match.value(input)` — match one concrete value immediately (what most call sites use).
- `Match.when(pattern, fn)` — `pattern` can be a **literal, object pattern, predicate, or refinement** (refinements narrow the branch).
- `Match.orElse(fn)` — false/default branch (receives the remaining type).
- `Match.exhaustive` — compile-time exhaustiveness when the remaining type is `never` (preferred terminator for unions).
- `Match.option` / `Match.either` — keep unmatched cases explicit (`Option`/`Either`) instead of a default.
- `Match.tag` / `Match.tags` / `Match.tagsExhaustive` / `Match.discriminator` / `Match.discriminatorsExhaustive` — ergonomic forms for discriminated unions (incl. `Schema.TaggedError` `_tag`).

Already used this way in the codebase: status rendering (`prediction.tsx`), `scheduleKind` / `ScheduleClassCell` (`prediction.tsx`), `orderEvents` (`event-filtering.ts`), `flipDir` (`event-filter-machine.ts`). Keep `jotai-solid-api` `<Show>`/`<For>` for lightweight presentational control flow; use `Match` for the logic.
