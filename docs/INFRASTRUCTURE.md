# corps-place — Infrastructure, Deployment & Backups

> **Status:** living doc, last updated **2026-06-15**. Captures the production
> topology, the read-model deploy pipeline (R2 push/pull — Turso retired
> 2026-06-15), the `dci-relational.db` backup system, and how all the
> secrets/credentials fit together. For the deep Coolify/VM mechanics see
> [`DEPLOYMENT_REALITY.md`](./DEPLOYMENT_REALITY.md); this doc is the higher-level
> map.

---

## 1. The whole picture in one diagram

```
                    YOUR LAPTOP (Windows)                         CLOUD
   ┌─────────────────────────────────────────┐
   │  dci-relational.db  (3.4 GB, source of   │   restic (encrypted, ~268 MiB)
   │  truth, gitignored, laptop-only)         │ ───────────────────────────────►  Cloudflare R2
   │            │                             │      daily 3AM scheduled task        bucket: corps-place
   │            │ emitReadModel.ts (offline)  │
   │            ▼                             │
   │  read-model.db (~79 MB)                  │   pushData.ts (S3 API)
   │            │                             │ ───────────────────────────────►  Cloudflare R2
   │            │                             │                                    bucket: corps-place
   └────────────┼─────────────────────────────┘                                    prefix: corps-data/read-model/
                │                                                                          │
                │ (build box also writes local A/B)                                        │ entrypoint pull on boot
                ▼                                                                          │ (pullReadModel.mjs) → A/B slot
        VPS /data/corps-place/read-model.db  ◄──────────────────────────────────────────┘
                │
                ▼
        TanStack Start SSR server (Docker, Coolify) ── Traefik/TLS ──►  drumcorps.app
```

> **Read-model delivery (2026-06-15):** Turso (the embedded replica) is retired.
> The read-model is a small read-only file distributed via the **R2** bucket
> already used for backups (`scripts/pushData.ts` uploads, the container entrypoint
> `scripts/pullReadModel.mjs` pulls on boot into the local A/B slot). The app reads
> ONLY the local file (`app/lib/read-model-db.ts`). See `DEPLOYMENT_REALITY.md` §5.

- **`dci-relational.db`** is the upstream source of truth (scraped/ingested DCI
  data + training inputs). It lives **only on the laptop**, is **gitignored** (too
  big), and is **never** on the request path. It is the feedstock the read-model
  and ML models are built from. → backed up to R2 (see §5).
- **read-model.db** is the small, flat, indexed projection the SSR server actually
  reads. Built offline by `sdk/scripts/emitReadModel.ts`, distributed via R2
  (`scripts/pushData.ts` ↔ `pullData.ts` / the container entrypoint).
- The **serving box** never touches the relational DB, tfjs, or models — it serves
  entirely from the read-model + a media-cache SQLite.

---

## 2. Production hosting (Coolify on one VM)

Full detail in [`DEPLOYMENT_REALITY.md`](./DEPLOYMENT_REALITY.md). Summary:

| Thing | Value |
| --- | --- |
| Box | single Vultr VM, `149.28.121.248` (hostname `vultr`), Ubuntu, 94 GB disk (~48 GB free) |
| Orchestration | self-hosted **Coolify 4.1.2** + Docker; builds from repo `Dockerfile` on git push |
| Prod | `drumcorps.app` ← branch `master`, data dir `/data/corps-place` |
| Dev | `dev.drumcorps.app` ← branch `dev`, data dir `/data/corps-place-dev` |
| Proxy/TLS | Coolify's **Traefik v3.6** + Let's Encrypt (HTTP-01) |
| Runtime | `node .output/server/index.mjs` on port 3000; health check `curl /` → 200 |
| App data | `read-model.*db` + `media-cache.db` **bind-mounted** at `/data` (NOT baked into image) |

**Deploy = `git push`** → Coolify webhook → rebuild image (tagged with commit SHA)
→ zero-downtime rollout. **The read-model DB is NOT shipped by git/Docker** — it is
mounted at runtime from the host (see §4).

### SSH access (added 2026-06-12)
- This laptop's `~/.ssh/id_ed25519` is authorized for **`root@149.28.121.248`** and
  **`patrick@149.28.121.248`** (`patrick` is in `sudo` + `docker` groups).
- `patrick` + the `docker` group is enough to edit root-owned `/data` via a throwaway
  container: `docker run --rm -v /data:/data alpine sh -c '...'`.

---

## 3. The read-model: build & A/B hot-swap

- Built by `sdk/scripts/emitReadModel.ts` against `dci-relational.db` (read-only).
  Every `rm_*` table is rebuilt from shared builders (`sdk/src/readModel/builders`)
  so emitted rows can't drift from what the live services compute.
- **Schema version** is bumped in the emitter when `rm_*` changes incompatibly.
- **Blue/green slots:** the server reads a *base* path (`READ_MODEL_DB_URL`) and
  derives `<stem>.a.db` / `<stem>.b.db` + a tiny `<stem>.active` pointer file. The
  emitter writes the new build into the **inactive** slot and atomically flips the
  pointer; the server (`app/lib/read-model-db.ts`) **polls the pointer every 5s** and
  hot-swaps with no restart. This is the current zero-downtime mechanism for *local*
  / bind-mount deploys.
- **Re-emit after data changes** (e.g. the DCX show backfill): `npx tsx
  scripts/emitReadModel.ts` (full emit; a partial `--only` writes a `.partial.db` and
  does NOT go live).

---

## 4. Turso (read-model delivery) — ⚠️ RETIRED 2026-06-15

> **This section is historical.** Turso (the embedded replica) was retired in favor
> of distributing the read-model as a plain object in the existing **R2** bucket:
> `scripts/pushData.ts` uploads it; the container entrypoint (`scripts/pullReadModel.mjs`)
> pulls it into the local A/B slot on boot. The app reads only the local file
> (`app/lib/read-model-db.ts` no longer has any replica/sync code), and the
> `READ_MODEL_REPLICA_ENABLED` / `READ_MODEL_SYNC_URL*` / `READ_MODEL_AUTH_TOKEN*`
> env vars are dead. See §5 / `DEPLOYMENT_REALITY.md` §5. The rest of this section
> is kept for history only.

**Why:** the read-model is produced offline but must reach prod. Shipping it via git
bloats history (binary, ~43 MB, fully rewritten each emit); baking into the image
loses the hot-swap and still bloats. Turso lets the box read the read-model from a
hosted libsql DB — no git bloat, no scp — and **embedded replicas** keep reads
local-fast.

### What's provisioned (done)
- Turso org **`doeixd`** (personal, starter plan), group **`default`** (aws-us-east-1).
- Two databases:

  | Env | Database | Sync URL |
  | --- | --- | --- |
  | Prod | `corps-read-model` | `libsql://corps-read-model-doeixd.aws-us-east-1.turso.io` |
  | Dev | `corps-read-model-dev` | `libsql://corps-read-model-dev-doeixd.aws-us-east-1.turso.io` |

- Per-DB **full-access auth tokens** minted (one each). Stored in `.env` (see §6).

### How it works
1. **`emitReadModel.ts --push-turso <url>`** builds the local read-model, publishes the
   local A/B slot as before, then streams the emitted `rm_*` tables into the Turso DB
   inside one write transaction (drop/create/batched insert). Use
   `--turso-auth-token <token>` or `READ_MODEL_AUTH_TOKEN`.
2. **`app/lib/read-model-db.ts` embedded-replica mode** activates when
   `READ_MODEL_REPLICA_ENABLED=1` **and** `READ_MODEL_SYNC_URL` are set. The app opens
   a local libsql replica with `syncUrl`, `authToken`, and `READ_MODEL_SYNC_INTERVAL_MS`
   (default 60s). Reads stay local-file fast; if Turso is unreachable the last synced
   replica keeps serving. **Two self-healing rules (added after deploys kept failing —
   see DEPLOYMENT_REALITY.md §15):**
   - **Serve from the local A/B slot until the replica's first sync completes.** A cold
     container must download the whole replica before it's queryable; blocking page
     reads on that tripped Coolify's healthcheck and failed deploys. So reads fall back
     to the persisted A/B files (ms-fast) until `replicaReady`, then hand off.
   - **Delete + rebuild the replica fresh on every process start.** A full read-model
     publish bumps Turso's replication generation; libsql then fails to sync a
     pre-existing replica **silently**, stranding the server on stale data (no error to
     catch). A clean rebuild from the current generation sidesteps it — no more manual
     "clear the replica" step. Caveat: a *long-running* server still needs a
     restart/deploy to pick up a publish, so the rule is **publish → then deploy/restart**.
3. **Coolify env** (per environment, NOT committed): `READ_MODEL_DB_URL=file:/data/read-model.db`,
   `READ_MODEL_SYNC_URL=<libsql url>`, `READ_MODEL_AUTH_TOKEN=<per-db token>`, **and
   `READ_MODEL_REPLICA_ENABLED=1`**. ⚠️ **The replica gate is `READ_MODEL_REPLICA_ENABLED`,
   not `READ_MODEL_SYNC_URL`.** If `SYNC_URL` is set but `REPLICA_ENABLED` is unset, the
   replica path is **silently off** and the app serves only the local A/B slot — so a
   `--push-turso` publish has no visible effect for that env.
   - **Current state:** **prod** has `REPLICA_ENABLED=1` (serves from Turso). **dev** has
     `SYNC_URL` but **not** `REPLICA_ENABLED` → dev ignores Turso and drifts stale, which
     is why `scripts/sync-dev-read-model.sh` exists as a workaround. Enabling
     `REPLICA_ENABLED=1` on dev (after the self-healing replica code is on the `dev`
     branch) makes dev symmetric and retires that workaround.
4. **Publish helpers.** Laptop: `scripts/publish-data.ps1 -Env prod|dev` (restic-backs-up
   the relational DB to R2, emits, pushes to that env's Turso DB; `-IncludeJsonSnapshot`
   also refreshes the `public/read-model` JSON shards). On the VM: the bash counterpart
   **`scripts/publish-read-model.sh <prod|dev> [--restart]`** (emit + push from the box's
   relational DB; `--restart` bounces the app to pick up the new generation immediately).
   `scripts/refresh-prod-read-model.sh` is the **break-glass** A/B-slot path, only used
   when Turso is down (and `REPLICA_ENABLED` flipped off).

### Provisioning reference (platform API)
Uses the **platform token** `TURSO_API_TOKEN` (org-scoped, distinct from the per-DB
read tokens):
```bash
TOKEN=$TURSO_API_TOKEN; ORG=doeixd
# list orgs / dbs / groups
curl -s -H "Authorization: Bearer $TOKEN" https://api.turso.tech/v1/organizations
curl -s -H "Authorization: Bearer $TOKEN" https://api.turso.tech/v1/organizations/$ORG/databases
# create a db in a group
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"<db>","group":"default"}' \
  https://api.turso.tech/v1/organizations/$ORG/databases
# mint a per-db full-access auth token (this is the runtime READ_MODEL_AUTH_TOKEN)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "https://api.turso.tech/v1/organizations/$ORG/databases/<db>/auth/tokens?authorization=full-access"
```

---

## 5. Backups — `dci-relational.db` → Cloudflare R2 (restic)

The relational DB is the **irreplaceable source of truth** and otherwise exists only
on the laptop. It is backed up with **restic** (encrypted, deduplicated, versioned)
to **Cloudflare R2** (S3-compatible object storage) — independent of both the laptop
and the VPS, which is why object storage was chosen over a copy on the VM.

### Repo
- Backend: `s3:https://<account>.r2.cloudflarestorage.com/corps-place`
  (account `07b7e6ea…`, bucket `corps-place`).
- First backup: 3.35 GiB → **~268 MiB stored** (restic compression). `restic check`
  passes.

### Automation
- Wrapper: **`scripts/backup-relational.ps1`** — loads `.env`, runs
  `restic backup`, then `restic forget --prune` with retention
  **7 daily / 4 weekly / 6 monthly**.
- Schedule: Windows Task Scheduler task **`corps-place-db-backup`**, daily **03:00**,
  `-StartWhenAvailable` (catches up if the laptop was off). Runs only while the
  laptop is on — see §7 on why git hooks aren't the primary mechanism.

### Common commands
```powershell
# (all read RESTIC_*/AWS_* from .env via the wrapper, or set them in the shell)
restic snapshots                       # list backups
restic check                           # verify repo integrity
restic restore latest --target <dir>   # restore newest snapshot
restic stats                           # repo size
# run a backup now:
pwsh -File scripts\backup-relational.ps1
```

> ⚠️ **`RESTIC_PASSWORD` is non-recoverable.** It is the only key that decrypts the
> backups. It lives in `.env` and must ALSO be stored off-machine (password
> manager). Losing it = backups permanently undecryptable.

### Contributions DB

The user-writable wiki store, `contributions.db`, is separate from the generated
read-model and should be treated as irreplaceable. The VM-side wrapper
`scripts/backup-contributions.sh` snapshots it with SQLite `.backup` and sends the
copy to the same restic/R2 repository with tag `contributions` and host
`corps-place-vm`.

```bash
# on the VM; reads RESTIC_*/AWS_* and CONTRIBUTIONS_DB_URL from .env when present
bash scripts/backup-contributions.sh

# optional explicit DB path, useful for host-mounted prod/dev volumes
bash scripts/backup-contributions.sh /data/corps-place/contributions.db

restic snapshots --tag contributions
```

Retention is intentionally longer than the generated relational DB wrapper:
**14 daily / 8 weekly / 12 monthly**. The script never backs up a live WAL file
directly; it restics only the consistent temporary `.backup` copy.

---

## 6. Secrets inventory

All live in the **gitignored repo-root `.env`** (never committed). Values are NOT
reproduced here — this is just what exists and what it's for.

| Env var | Purpose |
| --- | --- |
| `TURSO_API_TOKEN` | Turso **platform/org** token — create DBs, mint auth tokens. Not used at runtime. |
| `READ_MODEL_SYNC_URL` / `READ_MODEL_AUTH_TOKEN` | Prod Turso DB URL + per-DB read/write token. |
| `READ_MODEL_SYNC_URL_DEV` / `READ_MODEL_AUTH_TOKEN_DEV` | Dev Turso DB equivalents. |
| `RESTIC_REPOSITORY` | R2 restic repo URL. |
| `RESTIC_PASSWORD` | restic encryption key (**non-recoverable** — also store off-machine). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | R2 S3 access keys (restic auth). |
| `R2_API_TOKEN` | Cloudflare R2 bucket-management token (distinct from S3 keys). |
| `BROWSERBASE_API_KEY`, `GEOCODING_*` | Pre-existing scraper/geocoding keys. |

**Runtime (Coolify env, per environment)** — set in the Coolify UI, not in `.env`:
`READ_MODEL_DB_URL`, `READ_MODEL_SYNC_URL`, `READ_MODEL_AUTH_TOKEN`,
`MEDIA_CACHE_DB_URL`, `NODE_ENV`, `PORT`.

> 🔒 **Action item:** `docs/DEPLOYMENT_REALITY.md` currently contains a live Coolify
> API token at the bottom. Rotate it (Coolify → Settings → API Tokens) and remove it
> from the file — that file should never carry a secret, especially if it gets
> committed.

---

## 7. Why backups are a scheduled task, not a git hook

We considered triggering `restic backup` from a git hook (e.g. `pre-push`). It's a
poor fit as the **primary** mechanism:

- **Wrong trigger.** `dci-relational.db` changes from **scraping/ingestion**, which
  is unrelated to when you commit/push code. You could push code 20× in a day (20
  redundant backup scans) or go two weeks without a push (zero backups) — neither
  tracks the data.
- **Blocks your workflow.** A `pre-push` hook would make every push wait on a restic
  run; a `post-commit` hook fires far too often.
- **Only fires when you act.** A real backup cadence shouldn't depend on you
  remembering to push.

A **time-based scheduled task** (the daily 03:00 job) matches "back up the data on a
cadence regardless of code activity," which is what you actually want. restic's dedup
means an unchanged DB costs ~0 B, so a daily run is cheap.

**If you still want a git-hook safety net**, the sensible pattern is a *throttled*
hook that only backs up when the last snapshot is stale (e.g. >24 h) and runs in the
background so it never blocks — a complement to the schedule, not a replacement.
(Not currently set up; ask if you want it.)

---

## 8. Routine playbook

| Task | Command |
| --- | --- |
| Deploy code | `git push` (master→prod, dev→dev); Coolify rebuilds + rolls out |
| Rebuild read-model after data change | `cd sdk && npx tsx scripts/emitReadModel.ts` |
| Publish data to dev | `pwsh -File scripts/publish-data.ps1 -Env dev` |
| Reseed dev read-model from prod (on box) | `bash scripts/sync-dev-read-model.sh` (also nightly cron, 04:15) |
| Publish data to prod | `pwsh -File scripts/publish-data.ps1 -Env prod` |
| Push read-model only to Turso | `cd sdk && npx tsx scripts/emitReadModel.ts --push-turso $READ_MODEL_SYNC_URL` |
| Prepare a VM workspace | `bash scripts/vm-sync.sh dev` (or `prod`) |
| Back up relational DB now | `pwsh -File scripts/backup-relational.ps1` |
| Back up contributions DB now | `bash scripts/backup-contributions.sh` |
| Restore relational DB | `restic restore latest --target <dir>` (with `.env` loaded) |
| SSH to box | `ssh patrick@149.28.121.248` (or `root@…`) |
| Inspect what's deployed | `ssh patrick@149.28.121.248 "docker ps --format '{{.Names}}\t{{.Image}}'"` |
