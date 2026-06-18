# Merch — deployment, scheduling & data refresh

How the merch data pipeline runs in production (Coolify + Turso), how it's
scheduled, and the assumptions/edge cases behind it. Pairs with
[`MERCH_PLAN.md`](./plans/MERCH_PLAN.md) (the feature) and
[`DEPLOYMENT_REALITY.md`](./DEPLOYMENT_REALITY.md) / [`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md)
(the platform).

---

## 0. ✅ Prod-serving via the read-model (the "rm_merch" integration — DONE)

Merch now reaches prod the same way corps/judges/events do — through the Turso
read-model, **not** the 3.4 GB relational DB (which the serving container doesn't have).
Implemented + verified:

1. **`emitReadModel.ts` emits `rm_merch_*` tables** (a `merch` section, schema **v10**):
   - `rm_merch_meta` — single row: catalog **index** + **facets** + **store directory** JSON.
   - `rm_merch_product` — per-product `detail_json` (keyed by `product_id`).
   - `rm_merch_corps_teaser` — per-corps `teaser_json` (keyed by `slug`).
   These ride the `--push-turso` publish into the prod Turso DB.
2. **`readMerchSnapshot(db)`** (`sdk/src/readModel/readers.ts`) reads those tables into the
   builder-shaped snapshot. It's **resilient**: a pre-v10 read-model (tables absent) returns
   an empty snapshot instead of throwing, so a container deployed before its Turso DB is
   re-emitted shows an empty catalog rather than 500-ing.
3. **`MerchDirectoryService` uses `readOrBuild`** — `readModelEnabled()` → `readMerchSnapshot`
   from the read-model DB (the Turso replica in prod); else the big-DB builders (dev box).
   Same pattern as `CorpsDirectoryService`.

**Verified:** a `--only merch` emit wrote `rm_merch_meta`(1) / `rm_merch_product`(6555) /
`rm_merch_corps_teaser`(39); `readMerchSnapshot` read back 6555 products / 93 stores / 63
categories, and returned empty (no throw) against a DB without the tables.

> **Deploy ordering still matters:** schema went **v9 → v10**. Re-emit + `--push-turso`
> (i.e. `syncMerch --publish prod`) so the Turso DB has `rm_merch_*` **before** (or together
> with) deploying the code that reads them. The resilient reader means out-of-order is
> graceful (empty merch), not broken — but publish to make it non-empty.

---

## 1. Where the pipeline runs

The merch pipeline is **data-side**, not part of the SSR serving image:

| Concern | Lives where |
| --- | --- |
| 3.4 GB `dci-relational.db` (read **and written** by ingest) | the box's disk (this VM) — present today |
| `seed → ingest → emit → push-turso` | a process **with** that DB + Node 20 + the slim sdk deps |
| Serving (`drumcorps.app`) | the web container — **read-model only, no big DB, no sdk deps** |

So the pipeline runs **on the box directly** (as during development) or in a **dedicated
ingest container** — never inside the web container.

## 2. The one command — `syncMerch`

`sdk/scripts/syncMerch.ts` chains the whole refresh:

```bash
# Local (dev box): seed → ingest → emit a local JSON snapshot
npx tsx scripts/syncMerch.ts
npx tsx scripts/syncMerch.ts --scan          # + re-detect platforms first (slower)

# Publish to an env: seed → ingest → emit → push read-model to R2 → redeploy (Coolify API)
npx tsx scripts/syncMerch.ts --publish prod
npx tsx scripts/syncMerch.ts --publish dev --no-restart
```

> **Distribution is via R2, not Turso (2026-06-15).** The read-model is pushed to the
> Cloudflare R2 bucket (`corps-place`, prefix `corps-data/`) and the app pulls it on boot
> via its entrypoint (`scripts/pullReadModel.mjs`) into the local A/B slots. See
> DEPLOYMENT_REALITY.md §5.

- **`--publish <prod|dev>`** runs `emitReadModel` then `pushData read-model` (R2 upload),
  then **redeploys the app via the Coolify API** so the container pulls the new generation
  on boot (see §5). Needs the R2 env (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
  `R2_ENDPOINT`/`R2_BUCKET`) and `COOLIFY_API_TOKEN`. `--no-restart` skips the redeploy
  (data lands in R2; the running server shows it on its next pull/restart).
- Each step is the existing Effect program (`seedMerchStores`/`ingestMerch`/`emitReadModel`),
  so bounded concurrency, retries, per-store defect isolation, and layer-provided
  `SqlClient`/`BrowserbaseService` all apply.

## 3. The ingest image — `Dockerfile.merch-ingest`

A deliberately **slim** image (the merch + emit path imports **zero tfjs/ML** — verified):
it installs only `tsx`, `effect`, `@effect/sql-libsql`, `@libsql/client`, `cheerio`,
`@browserbasehq/sdk` — **not** `cd sdk && npm install` (which pulls tfjs-node ~1.4 GB)
and **not** the root install (which pulls `@browserbasehq/stagehand` → Playwright).

- Uses **`Dockerfile.merch-ingest.dockerignore`** (BuildKit per-Dockerfile ignore) so
  `sdk/scripts` + `sdk/src` are included — the base `.dockerignore` excludes `sdk/scripts`
  for the web build, which would otherwise omit the pipeline.
- The relational DB is **mounted read-write at runtime**, never baked in.
- `CMD ["sleep","infinity"]` so a Coolify Scheduled Task can `docker exec` into a
  long-lived container; for a one-off `docker run`, override the command.

> **Maintenance:** the pinned versions in the Dockerfile MUST track `sdk/package.json`.
> `effect` and `@effect/sql-libsql` must be the **same beta** — a mismatch breaks
> `Schema`/`Union` at runtime. (`@browserbasehq/sdk` is now a direct sdk dep — it was
> previously only transitive via stagehand.)

## 4. Scheduling — INSTALLED (host crontab)

**This is live.** The box runs its data jobs from **`patrick`'s crontab** (not Coolify
Scheduled Tasks — that's how `nightly-predictions.sh` and `sync-dev-read-model.sh` already
run), so merch follows the same pattern. Installed entry:

```cron
# Refresh merch (ingest live storefronts -> publish read-model to prod Turso -> redeploy) nightly @ 02:00
0 2 * * * /usr/bin/bash /root/corps-place/scripts/sync-merch.sh >> /home/patrick/sync-merch.log 2>&1
```

`scripts/sync-merch.sh` is a thin wrapper that puts the vite-plus-managed Node on PATH
(cron's PATH is minimal) and runs `npx tsx sdk/scripts/syncMerch.ts --publish prod`. It
reads all creds (Turso URL/token + `COOLIFY_API_TOKEN`) from the gitignored repo-root
`.env` via `syncMerch`'s own `loadRepoEnv` — no secrets in the script.

Each run: **seed → ingest (live storefronts) → emit `rm_merch_*` → `--push-turso` prod →
redeploy prod via the Coolify API** (so the new Turso generation is picked up, §5).

### Full scheduled-jobs inventory on the box (`crontab -l`)

| When (UTC) | Job | What it does | Touches prod how |
| --- | --- | --- | --- |
| `0 2 * * *` | **`sync-merch.sh`** | ingest merch → publish read-model → redeploy | Turso `--push-turso` + Coolify redeploy |
| `30 3 * * *` | `nightly-predictions.sh` | generate missing 2026 predictions → republish | A/B slot via `refresh-prod-read-model.sh` (legacy/conditional — early-exits if nothing missing) |
| `15 4 * * *` | `sync-dev-read-model.sh` | snapshot prod read-model → dev's A/B slot | dev only |
| `0 5 * * *` | **`backup-relational.sh`** | `sqlite .backup` → restic → R2 (host tag `corps-place-vm`) | none (backup only) — see §7 |

Ordering is deliberate: merch (02:00) finishes well before predictions (03:30) and the dev
sync (04:15), so the prod read-model publish + redeploy never overlaps another job (avoids
the publish-during-deploy contention in §5). Merch publishes via **Turso** (the channel
prod actually reads); the predictions job's A/B path is independent.

> **Cadence:** nightly is the default. Re-fetching ~90 storefronts every night is modest
> (most are direct fetch; Browserbase only for JS-rendered fallbacks), but if you want to be
> gentler on the stores / save Browserbase, change `0 2 * * *` to e.g. `0 2 * * 1,4`
> (Mon/Thu). Prices/products don't change daily.

### Alternative — Coolify Scheduled Task (if you'd rather manage it in the UI)
Not used (the box's convention is crontab), but viable: build a resource from
`Dockerfile.merch-ingest`, attach a persistent volume with the relational DB (host
`/data/corps-relational` → `/db`, set `DCI_RELATIONAL_DB_URL=file:/db/dci-relational.db`),
set the §6 env, and add a Scheduled Task running `npx tsx sdk/scripts/syncMerch.ts
--publish prod`. The container idles (`sleep infinity`) so Coolify can `docker exec` the
command; logs/run-history show in the dashboard. The trade-off vs the crontab: you must get
the 3.4 GB relational DB onto a Coolify volume and keep it backed up (§7).

## 5. The publish → restart caveat (important)

`emitReadModel --push-turso` does a full `DROP/CREATE/INSERT` on the Turso DB, which
**bumps the replication generation**. A **long-running** server stays on the OLD
generation until it **restarts** (the embedded replica only rebuilds fresh on process
start — see `app/lib/read-model-db.ts` and `DEPLOYMENT_REALITY.md` §15). So a scheduled
refresh **must end by redeploying/restarting prod**:

- `syncMerch --publish` does this via the Coolify **deploy** API (zero-downtime rollout) —
  preferred over a hard `docker restart` (brief blip).
- The replica also auto-syncs every ~60 s, but that does **not** cross a generation bump —
  the restart is what's required.

Also note: **emit republishes the entire read-model**, so merch's refresh cadence = the
whole read-model's cadence. A merch-only incremental publish is the optimization noted in
[`MERCH_PLAN.md`](./plans/MERCH_PLAN.md) §19; not built.

## 6. Environment variables (ingest resource / `merch.env`)

| Var | Purpose |
| --- | --- |
| `DCI_RELATIONAL_DB_URL` | `file:/db/dci-relational.db` — the mounted relational DB (read+write) |
| `BROWSERBASE_API_KEY` | optional; enables the Browserbase fallback for JS-rendered/blocked stores. Absent ⇒ direct-only (still works) |
| `READ_MODEL_SYNC_URL` / `READ_MODEL_AUTH_TOKEN` | prod Turso DB + token (`--publish prod`) |
| `READ_MODEL_SYNC_URL_DEV` / `READ_MODEL_AUTH_TOKEN_DEV` | dev Turso DB + token (`--publish dev`) |
| `COOLIFY_API_URL` | Coolify API base; default `http://localhost:8000` (must be reachable from the runner — use the box, or `https://coolify.drumcorps.app`) |
| `COOLIFY_API_TOKEN` | Bearer token for the post-publish redeploy; absent ⇒ publish succeeds but redeploy is skipped (warns) |
| `COOLIFY_PROD_APP_UUID` / `COOLIFY_DEV_APP_UUID` | app UUIDs to redeploy; default to the live ones (`if4odqr…` / `mjx3xn…`) |

## 7. Backups — INSTALLED (box-side restic → R2)

The merch cron **writes** `merch_products`/`merch_stores` into the box's
`/root/corps-place/sdk/dci-relational.db`, so the box now has its **own** backup (the
laptop's `backup-relational.ps1` only covers the laptop copy, which diverges):

- **`scripts/backup-relational.sh`** — Linux/VM counterpart to the laptop's `.ps1`. Takes a
  transactionally-consistent copy with `sqlite3 .backup` (safe under the concurrent merch
  writer; never `restic`s a live WAL'd file), then `restic backup` → the **same R2 repo**
  (creds from `.env`: `RESTIC_REPOSITORY`/`RESTIC_PASSWORD`/`AWS_*`). Distinct host tag
  **`corps-place-vm`** so box vs laptop snapshots separate; content **dedups** against the
  laptop's snapshots in the shared repo (first box backup uploaded only the delta in seconds).
  Retention: keep 7 daily / 4 weekly / 6 monthly, `--prune`.
- **Scheduled:** `patrick`'s crontab @ **05:00 UTC** (after merch 02:00, predictions 03:30,
  dev-sync 04:15) → `~/backup-relational.log`. Verified: first run created snapshot
  `corps-place-vm:dci-relational` (~3.36 GiB logical, deduped).
- **restic on the box:** installed as a static binary at `~/.local/bin/restic` (v0.17.3, no
  sudo — single binary from the official GitHub release).
- **Restore:** `~/.local/bin/restic snapshots --tag dci-relational`; `restic restore <id>
  --target /tmp/restore` (env from `.env`). `merch_*` is also re-derivable via re-ingest.

## 8. Assumptions (checked)

- ✅ **No tfjs in the merch/emit path** — `grep` over `readModel/`, `merchCatalog.ts`,
  `merchScan.ts`, `emitReadModel.ts`, the merch scripts found none. Enables the slim image.
- ✅ **The box has the relational DB + Node 20 + Turso creds** — verified on `149.28.121.248`
  (`sdk/dci-relational.db` 3.4 G; `.env` has the `READ_MODEL_SYNC_URL*`/token vars;
  `scripts/publish-read-model.sh` is the box publish path).
- ✅ **`emitReadModel --push-turso` exists** and reads `READ_MODEL_AUTH_TOKEN` (or
  `--turso-auth-token`); the prod container has `READ_MODEL_REPLICA_ENABLED=1` so it
  consumes Turso. **Dev does not** (`REPLICA_ENABLED` unset) → `--publish dev` lands in
  Turso but dev ignores it until that's enabled (per `INFRASTRUCTURE.md` §4).
- ✅ **Single writer** — only the ingest process writes the relational DB; the web never
  touches it and emit reads it. No multi-writer WAL contention.
- ⚠️ **`@browserbasehq/sdk` was transitive-only** (via `@browserbasehq/stagehand`); now
  declared directly in `sdk/package.json` so the slim image can install it without Playwright.
- ⚠️ **`effect` version split** — root is `beta.80`, sdk is `beta.79`. The pipeline runs
  under sdk's deps; the slim image pins `beta.79`. Keep the Dockerfile in lockstep with
  `sdk/package.json`.

## 9. Edge cases

- **Coolify API unreachable / no token** → `syncMerch --publish` still publishes to Turso,
  warns, and exits 0; prod shows new data only after its next restart/deploy. (Don't treat
  a skipped redeploy as a failed sync.)
- **Publish during a deploy** → a concurrent full Turso republish + a cold container's
  replica sync can blow the health-check window. Now self-healing (serve from A/B until
  warm; rebuild replica each start — `DEPLOYMENT_REALITY.md` §15), but prefer not to
  overlap a scheduled publish with a code deploy.
- **A store fetch throws a defect** (e.g. a scheme-less URL in `new URL()`) → isolated per
  store via `Effect.catchCause` in `ingestMerch`; the batch continues, the store is marked
  `error`. (`originOf`/seed also normalize URLs.)
- **`BROWSERBASE_API_KEY` absent** → `BrowserbaseServiceLive` isn't provided; adapters read
  it via `serviceOption` and run direct-only (Wix/JS-rendered stores yield fewer products).
- **`media-cache.db` write-perms** (image proxy) are a *serving*-side concern, unrelated to
  the ingest job — see `MERCH_PLAN.md` notes.
- **Relational DB absent in the ingest container** (volume not mounted) → builders'
  `rowsOrEmpty` returns empty and the publish ships an empty merch read-model — fail fast
  by asserting the DB exists before publishing if this becomes a footgun.

## 10. TL;DR — LIVE

Merch is **live on `drumcorps.app`** and **self-refreshing**:
- Serves via the Turso read-model (§0 `rm_merch_*` + `readOrBuild` — done; no relational DB
  in the web container).
- First publish + prod deploy shipped (commit on `master`, `rm_merch` pushed to prod Turso).
- **Scheduled:** `scripts/sync-merch.sh` on `patrick`'s crontab @ **02:00 UTC** does
  ingest → publish → redeploy nightly (§4). `COOLIFY_API_TOKEN` is in `.env` so the redeploy
  step works.

Open/optional: a **box-side DB backup** for the now-mutated relational DB (§7), and a
**merch-only incremental emit** if you want a faster cadence than the full read-model
republish (§5; `MERCH_PLAN.md` §19).
