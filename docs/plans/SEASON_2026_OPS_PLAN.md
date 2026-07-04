# Season 2026 Ops & Roadmap Plan (written 2026-07-04)

Context: DCI season is ramping toward Finals (mid-August). Peak traffic is
coming; the site's job for the next six weeks is to be boring and reliable.
Priorities below are ordered; #1 starts immediately.

## 1. Ops stability before the traffic peak — THIS WEEK

The dominant failure source over the last two days was the box, not code:
~15 deploy failures from the <10 GiB disk guard (each prod+dev deploy pair
regenerates ~9 GB of BuildKit cache), plus two build OOMs where the build
competed with the live app for the ~3.8 GB of RAM.

- **Off-box builds (in progress)**: GitHub Actions builds the production
  Docker image and pushes to GHCR (`ghcr.io/doeixd/corps-place`); Coolify
  deploys by pulling the image instead of building on the box. Kills the
  disk-guard and build-OOM failure classes entirely. Rollback: switch the
  Coolify app's build pack from `dockerimage` back to `dockerfile` — the
  Dockerfile stays in the repo and keeps working.
- **Cloudflare zone API token on the box**: twice the answer to edge
  poisoning was "rotate the asset path because we can't purge" (r1→r2).
  A purge token turns that into one API call — wanted before Finals night.
  (Manual step: create a zone-scoped token in the CF dashboard, add to
  /root/corps-place/.env as CF_ZONE_API_TOKEN.)
- **Backups audit**: restic covers dci-relational.db only. contributions.db
  (users, fantasy leagues, ballots) and fantasy.db have only ad-hoc .bak
  files — add them to the restic job before the season stakes rise.

## 2. Redact experiment: soak on dev, decide after Finals

Bakeoff results (2026-07-04, production-parity images, same box):
SSR TTFB −13–24%, 10-parallel throughput −30%, JS payload −14%, FCP −8%,
interaction latency −14%, typing main-thread blocking −36% — but total
startup (DCL/load) +300–500 ms at phone-class CPU, even warm.

- Profile where startup goes (suspects: ~80-chunk module graph on first
  nav, SW proxy overhead, redact hydration walk).
- Watch TanStack/redact#17 (our four filed hydration bugs) — two pnpm
  patches should become upstream fixes.
- **Do not switch prod runtimes mid-season.** Decision point: late August.

## 3. Product: capitalize on the season

- **M5: post-finals grading + community consensus** for prediction ballots
  ("how did my picks do?") — the retention hook; must exist BEFORE Finals.
- 1-member fantasy draft start (deferred earlier; guards at
  draft-engine.ts and draft-service.ts, machine copy 'need-two-members').
- Surface score-notify harder — the button has good UX now (subscribed
  state + unsubscribe) but users have to find it.

## 4. Hygiene (background)

- Type the hybrid.ts server-fn boundary (the `any`s there hid two real
  regressions this week: loader/shard row-shape drift).
- Make the dev error beacon permanent-with-rate-limit instead of TEMP —
  it caught a device-class-specific fatal no probe could reach.
- Post the react-db getServerSnapshot findings on TanStack/db#1016
  (upstream tracks SSR support in #545 / PR #709; our pnpm patch is
  load-bearing until then).
- Retire the legacy /predict/palette page if the finals editor has fully
  replaced it.
