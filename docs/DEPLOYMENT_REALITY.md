# Deployment — how corps-place actually runs (Coolify on a single VM)
> **Status:** reflects the live state of the production box as of **2026-06-12**.
> This document describes *what is actually deployed*, discovered by inspecting the
> running server. Where it contradicts older docs (`DEPLOY-legacy-exe.dev.md`, `deploy.ps1`), this
> document is correct and those are stale — see [§9 What's no longer relevant](#9-whats-no-longer-relevant).
---
## 1. TL;DR
- The app is deployed with **self-hosted [Coolify](https://coolify.io) 4.1.2** running on **one VM** (`149.28.121.248`).
- Coolify **watches the GitHub repo** (`doeixd/corps-place`) and **builds + deploys on push** via the project's `Dockerfile`.
- There are **two environments on the same box**, both Coolify "Application" resources:
  | Env | Domain | Git branch | Data dir on host |
  | --- | --- | --- | --- |
  | **Production** | `drumcorps.app` | `master` | `/data/corps-place` |
  | **Development** | `dev.drumcorps.app` | `dev` | `/data/corps-place-dev` |
- The app is a **TanStack Start (React 19) SSR server** that serves entirely from a small
  precomputed **read-model SQLite** + a **media cache SQLite**. It does **not** touch the
  3.6 GB relational DB, tfjs, or any model at request time.
- **TLS, routing, and HTTP→HTTPS** are handled by Coolify's bundled **Traefik** reverse proxy
  with **Let's Encrypt** (HTTP-01 challenge). Ports 80/443 are the only app-facing ports.
- The **Coolify dashboard itself** is exposed at **`https://coolify.drumcorps.app`** (see [§6](#6-the-coolify-dashboard-coolifydrumcorpsapp)).
---
## 2. The box
- **Host:** single Linux VM, public IPv4 `149.28.121.248` (also has IPv6
  `2001:19f0:5c00:43f8:5400:6ff:fe3e:4000`). Kernel `Linux 6.8 generic`, Ubuntu-family.
- **Disk:** `/dev/vda2`, 94 GB total, ~52 GB free (43% used) at time of writing.
- **Login user:** `patrick` (uid 1001), in groups `sudo`, **`docker`**, `corps-place`.
  - `sudo` requires a password (no passwordless sudo).
  - Because `patrick` is in the **`docker`** group, anything root-owned on disk can be
    manipulated by running a throwaway container with a bind mount, e.g.
    `docker run --rm -v /data:/data alpine sh -c '...'`. This is how data dirs under
    `/data` (root-owned) get edited without `sudo`.
- **Everything is Docker.** Nothing app-related runs under systemd directly; there is no
  nginx/certbot. The whole stack is containers managed by Coolify.
---
## 3. What's running (containers)
```
NAMES                                   IMAGE                                  ROLE
mjx3xnpbm0bpwo80ts6t2mys-<id>           mjx3xnpbm0bpwo80ts6t2mys:<commit>      DEV app  (dev.drumcorps.app)
if4odqr9tkybb0uezey95mid-<id>           if4odqr9tkybb0uezey95mid:<commit>      PROD app (drumcorps.app)
coolify                                 ghcr.io/coollabsio/coolify:4.1.2       Coolify control plane (Laravel/PHP)
coolify-proxy                           traefik:v3.6                           Reverse proxy / TLS (80,443,8080)
coolify-db                              postgres:15-alpine                     Coolify's own metadata DB
coolify-redis                           redis:7-alpine                         Coolify queue/cache
coolify-realtime                        ghcr.io/coollabsio/coolify-realtime    Websocket/live updates (soketi)
coolify-sentinel                        ghcr.io/coollabsio/sentinel            Metrics/health agent
```
Key facts:
- **App containers are named `<app-uuid>-<random>`** and expose port `3000` internally only
  (no host port publish). Traefik reaches them over the shared `coolify` Docker network.
- The **image tag is the deployed git commit SHA** (e.g. `...:e38946d462c9...`). That's how
  you tell at a glance which commit a container is running.
- Coolify's own containers (control plane, db, redis, realtime, proxy, sentinel) are the
  standard Coolify install and persist their state under `/data/coolify/`.
### App UUIDs (stable identifiers)
| Env | Coolify app UUID | Coolify DB `applications.id` |
| --- | --- | --- |
| Prod | `if4odqr9tkybb0uezey95mid` | 1 |
| Dev  | `mjx3xnpbm0bpwo80ts6t2mys` | 2 |
These UUIDs appear in: container names, image names, and Traefik router/service label names.
---
## 4. How a deploy happens
1. You push to GitHub. Coolify is connected to the repo through a **GitHub App** (named
   "corps-place" in Coolify's sources; the repo is otherwise public so reads work anonymously).
2. Coolify's webhook fires; it picks the resource whose `git_branch` matches the pushed branch:
   - push to **`master`** → rebuilds/redeploys **prod** (`drumcorps.app`)
   - push to **`dev`** → rebuilds/redeploys **dev** (`dev.drumcorps.app`)
3. Coolify builds the image from the repo's root **`Dockerfile`** (build pack = `dockerfile`),
   tagging it with the commit SHA.
4. Coolify does a **zero-downtime rollout**: it starts the new container, waits for the
   **health check** (`curl` to `/` returns 200 — this is why the Dockerfile installs `curl`),
   then swaps Traefik over and stops the old container. The old container keeps serving the
   whole time the new one is building.
### Triggering a deploy by hand
Coolify exposes a REST API on `http://localhost:8000/api/v1` (Bearer token from
**Settings → API Tokens** in the dashboard). Useful calls:
```bash
TOKEN='<coolify-api-token>'
# List apps (find UUIDs)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/applications
# Restart (recreate container from current config — fast, no rebuild;
# picks up changed volume mounts / env without pulling new code)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/v1/applications/<uuid>/restart
# Full redeploy (pull latest branch + rebuild image)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/v1/deploy?uuid=<uuid>&force=true"
```
> **Restart vs deploy:** *restart* recreates the container from Coolify's current stored
> config (good for picking up a changed mount or env var). *deploy* re-pulls the branch and
> rebuilds the image (needed to ship new code). A config change in Coolify's DB only takes
> effect once the container is **recreated** — a plain `docker restart` will *not* pick up a
> changed bind mount, because mounts are fixed at container creation.
### The `Dockerfile` (what gets built)
- Single stage on `node:20-bookworm-slim`. `NODE_ENV=production`, `PORT=3000`.
- Installs OS toolchain + **`curl`** (for the Coolify health check) + build tools for any
  native gyp fallback (`sharp`).
- **`npm install --include=dev`** (not `npm ci`): the committed `package-lock.json` was
  generated on Windows and is missing Linux-only optional `sharp` deps (`@img/*`, `@emnapi/*`),
  which makes `npm ci` reject it. `--include=dev` is required because `NODE_ENV=production`
  would otherwise skip the build tools (vite, vite-plus). Dev deps are pruned after build.
- Builds the TanStack Start app to `.output/server`, then `npm prune --omit=dev`.
- **Does NOT install `sdk/` deps** (no `tfjs-node`) and does **not** bake in any DB or model —
  those are mounted at runtime (see [§5](#5-data-runtime-volumes-and-the-isolation-model)).
- Runtime entrypoint: `node .output/server/index.mjs`.
---
## 5. Data: runtime volumes and the isolation model
The app needs two SQLite DBs at runtime, both supplied by a **host bind mount** into the
container at `/data`:
| File | Purpose | Env var pointing at it |
| --- | --- | --- |
| `read-model.db` (+ `read-model.a.db`, `read-model.b.db`, `read-model.active`) | precomputed read-model the SSR pages read from; `.a`/`.b` + `.active` are a blue/green pair with a pointer file | `READ_MODEL_DB_URL=file:/data/read-model.db` |
| `media-cache.db` | cached/proxied media (image proxy) — **written at runtime** | `MEDIA_CACHE_DB_URL=file:/data/media-cache.db` |
Total data footprint is small (~338 MB), so duplicating it per-environment is cheap.

> **Updating prod page data — distributed via R2 (replaces Turso, 2026-06-15).**
> Turso (the embedded replica) is being retired — it hit a plan read-block and the
> read-model is just a small, batch-built, read-only file, so it's now distributed
> as a plain object in the existing Cloudflare **R2** bucket (`corps-place`, under the
> `corps-data/` prefix — the same bucket restic backs up to). The app still serves
> from the **local A/B files** in `/data/corps-place`; R2 is only the courier.
> - **Push (ingest/build side):** `cd sdk && npm run push:data read-model` (or
>   `relational`/`media-cache`/`all`). The merch and season-update workflows push
>   automatically (`syncMerch.ts --publish`, `seasonUpdateWorkflow.ts`).
> - **Pull (app side):** the container **entrypoint** (`docker-entrypoint.sh` →
>   `scripts/pullReadModel.mjs`) pulls `read-model` from R2 into `/data` on boot
>   (into the inactive A/B slot, then flips `read-model.active`). Best-effort: on any
>   failure it logs and the app still boots on the on-disk files. So a redeploy =
>   fresh data; for no-redeploy refresh, run `cd sdk && npm run pull:read-model` on
>   the VM (hot-swaps within ~5 s via the pointer poll), e.g. from cron.
> - **Cutover steps (Coolify env on the prod + dev apps):** set
>   `READ_MODEL_REPLICA_ENABLED=0` and add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
>   `R2_ENDPOINT` (or `RESTIC_REPOSITORY`), `R2_BUCKET=corps-place`, `R2_PREFIX=corps-data`.
>   The `READ_MODEL_SYNC_URL*` / `READ_MODEL_AUTH_TOKEN*` (Turso) vars can be dropped
>   once verified. Verify on dev first.
> - ✅ **Auto-deploy-on-push FIXED 2026-06-12.** It previously didn't fire because the
>   prod app was bound to Coolify's anonymous **"Public GitHub"** source
>   (`applications.source_id=0`) and had a **NULL `repository_project_id`**, so inbound
>   GitHub-App push webhooks (matched by numeric repo id + branch + source) never matched
>   prod — only dev (which had `source_id=1`, `repository_project_id=1131326681`) deployed.
>   Fixed by setting prod's `source_id=1` and `repository_project_id=1131326681` (the repo
>   id, `gh api repos/doeixd/corps-place --jq .id`) in `coolify-db` — now matching dev.
>   Verified: a push to `master` auto-built + rolled out prod with no manual trigger. The
>   blessed equivalent is the Coolify UI → prod app → **Source** = the *corps-place* GitHub
>   App. (Env-var/config-only changes still need an explicit Coolify *restart/deploy*, since
>   those aren't a git push — note `personal_access_tokens` need a non-null `team_id`.)
### How Coolify stores the mount
Each app's bind mount lives in Coolify's Postgres, table **`local_persistent_volumes`**:
```
id | name                                 | mount_path | host_path             | resource (App\Models\Application id)
 1 | if4odqr9tkybb0uezey95mid-corps-data  | /data      | /data/corps-place     | 1  (prod)
 2 | mjx3xnpbm0bpwo80ts6t2mys-corps-data  | /data      | /data/corps-place-dev | 2  (dev)
```
Coolify regenerates each container's compose/run config from this row, so editing
`host_path` here is **durable** across redeploys (unlike a raw `docker run -v` change, which
would be wiped on the next deploy).
### Environment isolation (done 2026-06-12)
Originally **both** prod and dev mounted the **same** host dir `/data/corps-place`, so dev's
runtime writes (notably `media-cache.db`) contaminated prod. This was fixed:
1. Copied the data to a separate dir: `/data/corps-place-dev` (via a root `alpine` container,
   since `/data` is root-owned).
2. Updated the dev row in `local_persistent_volumes` (`id=2`) `host_path` →
   `/data/corps-place-dev`.
3. Restarted the dev app via the Coolify API so the container was recreated with the new mount.
Result: prod and dev now have **fully independent data dirs** (verified: different inodes for
`media-cache.db`). Dev was seeded with a snapshot of prod's data and diverges from there.
> **Dev data is reseeded from prod nightly** (added after dev's stale read-model made
> date-relative home widgets vanish). **`scripts/sync-dev-read-model.sh`** snapshots
> what prod currently serves (its Turso replica, or active A/B slot) and hot-swaps it
> into dev's inactive A/B slot + flips the pointer — zero downtime, no restart, all
> `/data` work in a throwaway `alpine` container (docker group, no sudo). It runs from
> **`patrick`'s crontab at 04:15** (`>> ~/sync-dev-read-model.log`); run by hand any
> time with `bash scripts/sync-dev-read-model.sh`. Between runs dev still drifts, so if
> a section is missing on dev, reseed before debugging the component.
### Per-environment differences
Both environments run the **same Docker image / same branch HEAD** is *not* guaranteed — they
track different branches now. The only env-var difference is `NODE_ENV` (prod=`production`,
dev=`development`); both set `PORT=3000`, `READ_MODEL_DB_URL`, `MEDIA_CACHE_DB_URL`.
---
## 6. The Coolify dashboard (`coolify.drumcorps.app`)
The Coolify control panel listens on host port **`8000`** (`8000→8080` publish). It was
originally only reachable at `http://149.28.121.248:8000`. It's now also at
**`https://coolify.drumcorps.app`**.
### How that route was set up — and why NOT via Coolify's own setting
Coolify has a built-in **Settings → Instance Domain** field that's *supposed* to do this. In
practice, **saving it kept reverting** (`instance_settings.fqdn` stayed empty, no Traefik
labels appeared on the `coolify` container). Coolify applies the instance domain by
**self-redeploying its own container** to inject Traefik labels; when that flow fails it rolls
back — and a failed attempt there can lock you out of the panel.
Instead, the route was added as a **Traefik dynamic config file**, which is self-contained and
cannot break the running panel:
- File: `/data/coolify/proxy/dynamic/coolify-dashboard.yaml`
  (host dir `/data/coolify/proxy` is mounted into `coolify-proxy` at `/traefik`; Traefik runs
  `--providers.file.directory=/traefik/dynamic/ --providers.file.watch=true`, so new files are
  picked up live, no restart).
- It defines an HTTPS router for `Host(\`coolify.drumcorps.app\`)` → service
  `http://coolify:8080` (reachable because `coolify` and `coolify-proxy` share the `coolify`
  Docker network), an HTTP router that redirects to HTTPS, and `tls.certResolver: letsencrypt`.
- Traefik issued a valid Let's Encrypt cert via HTTP-01 challenge (verified: `CN =
  coolify.drumcorps.app`, issuer Let's Encrypt, chain validates).
> **Caveat / durability:** this file persists across app deploys. The one thing that would
> remove it is later setting the **Instance Domain inside Coolify's UI** — at which point
> Coolify manages its own routing and you'd delete this manual file. Don't mix the two.
### HSTS gotcha
`drumcorps.app` serves **HSTS with `includeSubDomains`**, so browsers hard-refuse *any*
`*.drumcorps.app` subdomain that doesn't present a valid cert — no click-through. If you hit a
subdomain before its cert is ready, the browser caches the failure; clear it at
`edge://net-internals/#hsts` (or `chrome://net-internals/#hsts`) → "Delete domain security
policies" for that host.
---
## 7. Networking / TLS summary
- **`coolify-proxy` (Traefik v3.6)** owns host ports **80, 443 (TCP+UDP/HTTP3), 8080** (Traefik
  dashboard/ping). It is the single ingress.
- **Providers:** Docker (label-based, `exposedbydefault=false`) **and** file
  (`/traefik/dynamic/`, watched).
- **Cert resolver:** `letsencrypt`, **HTTP-01** challenge on the `http` entrypoint, storage at
  `/traefik/acme.json`.
- **Per-app routing** comes from Traefik **labels** Coolify puts on each app container, e.g.
  `Host(\`drumcorps.app\`)` / `Host(\`dev.drumcorps.app\`)`, plus a gzip middleware and an
  HTTP→HTTPS redirect. Each app's loadbalancer targets container port `3000`.
- **DNS:** `drumcorps.app`, `dev.drumcorps.app`, and `coolify.drumcorps.app` all resolve to
  this box (`149.28.121.248`).
### Open ports worth knowing
- `80`, `443` — public app + dashboard ingress (Traefik). Expected.
- `8000` — **Coolify dashboard, still published to the internet** even though the HTTPS domain
  now exists. Consider firewalling it off so the panel is only reachable via
  `https://coolify.drumcorps.app`. (Not yet done.)
- `8080`, `6001/6002` — Traefik dashboard and realtime; Coolify defaults.
---
## 8. Operational runbook (this deployment)
```bash
# What's running and which commit
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
# Which container is which env / what mount it has
docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}'
docker inspect <container> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -i 'Host('
# Coolify's source of truth for branches + volumes (read-only peeking)
docker exec coolify-db psql -U coolify -c \
  "select id,uuid,name,git_branch,git_repository from applications order by id;"
docker exec coolify-db psql -U coolify -c \
  "select id,name,mount_path,host_path,resource_id from local_persistent_volumes;"
# Edit root-owned /data without sudo (patrick is in the docker group)
docker run --rm -v /data:/data alpine sh -c 'ls -la /data/corps-place'
# App logs
docker logs <app-container> --tail 100
# Verify a host serves (locally, through Traefik)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: drumcorps.app' https://127.0.0.1/ -k
```
**Change which branch an env tracks:** update `applications.git_branch` in `coolify-db`
(or the UI's *Source* settings), then trigger a deploy via the API. (This is how dev was
moved from `master` to `dev`.)
**Change an env's data dir:** update the `host_path` in `local_persistent_volumes`, ensure the
target dir exists/populated, then **restart** (recreate) the container.
> ⚠️ Direct edits to Coolify's Postgres are durable but unsupported. The UI is the blessed
> path; the DB route is a fallback when the UI misbehaves (as it did for the instance domain).
> A Coolify Bearer **API token** with full control of the box was used during setup — if one
> was pasted into a chat/log, **rotate it** (Settings → API Tokens).
---
## 9. What's no longer relevant
The repo's older deployment material describes a **different, never-deployed plan**. Treat it
as historical:
- **`DEPLOY-legacy-exe.dev.md`** — describes a single VM on **exe.dev** with the app run by **systemd**
  (`node .output/server/index.mjs`), a **nightly cron** that scrapes → ingests → fine-tunes a
  tfjs model → pre-generates predictions, sized for the **~5 GB fine-tune peak / 8 GB RAM**,
  with the **3.6 GB relational DB on the request path**. **None of this matches reality:**
  - Hosting is **Coolify + Docker on a Vultr-style VM**, not exe.dev/systemd.
  - The serving image **has no tfjs, no model, and no relational DB** — it serves only the
    small read-model + media-cache SQLite mounted at `/data`.
  - There is **no nightly training/prediction cron on the box** as part of this deployment.
    (Read-model and media-cache DBs are produced elsewhere/offline and placed on the host.)
  - TLS is **Traefik + Let's Encrypt**, not an "exe.dev edge."
  - The exe.dev sizing/swap/`exeuntu` runbook is moot.
  > The *architecture rationale* in `DEPLOY-legacy-exe.dev.md` (predictions are cached DB rows; serving needs
  > no GPU/model; heavy work is offline) is still conceptually accurate and is in fact how the
  > read-model serving image is shaped. Only the *hosting mechanics* are wrong.
- **`deploy.ps1`, `startup-deploy.bat`, `deploy-nonascii.txt`** — Windows/PowerShell deploy
  scripting. Not used by the Coolify pipeline (Coolify builds from the `Dockerfile` on push).
- **API/data-source notes in `AGENTS.md`** about `api.dci.org`, the website scraper,
  Browserbase, etc. remain accurate for the **data/SDK** side, but are unrelated to **serving**
  — the request path only reads the precomputed read-model.
- **The "Astro" `README.md`** is the leftover starter-kit readme; the app is **TanStack
  Start**, mid-migration (`docs/plans/MIGRATION_*`). Ignore the README for deployment.
---
## 10. Quick reference
| Thing | Value |
| --- | --- |
| Box IPv4 | `149.28.121.248` |
| Prod URL / branch / data | `https://drumcorps.app` / `master` / `/data/corps-place` |
| Dev URL / branch / data | `https://dev.drumcorps.app` / `dev` / `/data/corps-place-dev` |
| Coolify dashboard | `https://coolify.drumcorps.app` (and `http://149.28.121.248:8000`) |
| Coolify version | 4.1.2 |
| Reverse proxy | Traefik v3.6 (`coolify-proxy`), Let's Encrypt HTTP-01 |
| Build | repo `Dockerfile`, `node:20`, image tag = commit SHA |
| Runtime entry | `node .output/server/index.mjs` on port 3000 |
| Health check | `curl` GET `/` → 200 (zero-downtime rollout) |
| App data | `read-model.*db` + `media-cache.db` bind-mounted at `/data` |
| Coolify metadata DB | `coolify-db` (postgres), tables `applications`, `local_persistent_volumes`, `instance_settings` |
| Manual Traefik route | `/data/coolify/proxy/dynamic/coolify-dashboard.yaml` |
> Security note: a live Coolify API token was previously pasted here. It has been
> removed from the document, but any token exposed in git history should still be
> rotated in Coolify (Settings -> API Tokens).

## 15. Deploy gotchas (learned the hard way)

- **Health check is tight: `curl /` with a 5s timeout, 10 retries (≈50s window).**
  On a cold start the app must warm its Turso embedded replica before `/` renders,
  and if that first render exceeds 5s on every retry the deploy is marked failed and
  Coolify **rolls back to the old container** (no downtime, but the new code doesn't
  ship). Config lives in `coolify-db.applications` (`health_check_timeout` etc.).
- **Don't push the read-model to Turso *during* a deploy.** A `publish-data` /
  `emitReadModel --push-turso` does a full `DROP TABLE`/`CREATE`/`INSERT` on Turso;
  if a freshly-started deploy container is syncing its replica at the same moment,
  the contended sync blows past the 5s health check and the deploy fails. **Publish
  the read-model first, let it settle, then deploy** (or vice-versa — just not
  concurrently).
- **Empty commits don't trigger Coolify.** `git commit --allow-empty` + push does
  *not* fire the deploy webhook; push a real change (or trigger via the API/UI).

### Replica is now self-healing (code, `app/lib/read-model-db.ts`)
The first two gotchas above are handled in code as of this change, so the manual
"clear the replica" dance is no longer needed:
- **Reads serve from the local A/B slot until the embedded replica's first sync
  completes**, so a cold-started container is responsive in ms and never blocks the
  healthcheck on the replica download (the replica takes over once warm).
- **The replica file is deleted and rebuilt fresh on every process start**, so a
  generation bump from a read-model publish can't strand the server on stale data
  (libsql fails that sync silently, so there's no error to catch — a clean rebuild
  sidesteps it entirely).
- Remaining caveat: a **long-running** server still won't see a publish until it
  restarts (its in-flight replica is on the old generation). A deploy/restart heals
  it. If you publish without deploying, restart the app (or trigger a deploy).
