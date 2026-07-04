# Production image for the corps-place web app (Coolify / Docker).
#
# Serves SSR + page reads from the precomputed read-model (the small rm_* SQLite),
# so it needs NO tfjs/model and NO 3.6 GB relational DB on the request path. The
# read-model + media-cache DBs are NOT baked in — mount them at runtime
# (Coolify persistent volume).
#
# Multi-stage build: builder stage has full dev toolchain + all deps for the
# TanStack Start compilation; production stage gets only runtime deps + build
# output. Cuts the final image from ~3 GB to ~800 MB.
# Uses pnpm for 2x faster installs + persistent content-addressable store across
# rebuilds (BuildKit cache mount on /root/.pnpm-store).

# ============================================================
# Builder: full toolchain + all deps + app build
# ============================================================
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Cap Node.js heap so the build doesn't OOM the Docker container (Vite/Rolldown +
# TypeScript compilation is memory-hungry). Tune to your Coolify VM's RAM.
# NOTE: the VM is only ~3.8 GiB and runs the OLD app container (≈1 GiB) during the
# zero-downtime rollout, so a 3072 build heap pushed total RSS past physical RAM
# and the build started OOM-failing under load. `vite build` fits comfortably in
# 2048 (verified), so cap there to leave headroom for the running container.
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Native toolchain for sharp and any native gyp fallback
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install ALL deps (dev + prod) — cache-friendly: deps before source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
ENV PNPM_STORE_DIR=/root/.pnpm-store
RUN --mount=type=cache,target=/root/.pnpm-store \
 pnpm install --frozen-lockfile

# App source (sdk/src is included for @sdk/* imports; heavy sdk dirs are .dockerignored)
COPY . .
# Feature flags are baked at build time (vite inlines import.meta.env). These
# used to come from Coolify's build env; with off-box GH-Actions builds the
# image must carry them itself — defaults ON so a plain `docker build` matches
# what prod has always shipped.
ARG VITE_ENABLE_FANTASY=true
ARG VITE_ENABLE_SW=true
ENV NODE_ENV=production VITE_ENABLE_FANTASY=$VITE_ENABLE_FANTASY VITE_ENABLE_SW=$VITE_ENABLE_SW
RUN npm run build
# Fail the build if server-only code leaked into the client bundle (blank-site class).
RUN node scripts/check-client-bundle.mjs

# ============================================================
# Production: slim image with only runtime deps + build output
# ============================================================
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    CONTRIBUTIONS_DB_URL=file:/data/contributions.db

# Only what the runtime actually needs: curl+wget (health check), ca-certificates (HTTPS)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl wget \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install production deps only — no TypeScript, puppeteer, vite etc.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
ENV PNPM_STORE_DIR=/root/.pnpm-store
RUN --mount=type=cache,target=/root/.pnpm-store \
 pnpm install --prod --frozen-lockfile

# Build output + entrypoint + R2 pull script (from builder)
COPY --from=builder /app/.output .output
COPY --from=builder /app/docker-entrypoint.sh docker-entrypoint.sh
COPY --from=builder /app/scripts/pullReadModel.mjs scripts/pullReadModel.mjs
COPY --from=builder /app/scripts/pullMediaCache.mjs scripts/pullMediaCache.mjs
# Deterministic boot-time contributions.db migration + its shared column list.
COPY --from=builder /app/scripts/migrate-contributions.mjs scripts/migrate-contributions.mjs
COPY --from=builder /app/scripts/contributions-migrations.mjs scripts/contributions-migrations.mjs
# ZIP centroid dataset seeded into contributions.db at boot (sort-by-closest).
COPY --from=builder /app/scripts/zip-centroids.csv scripts/zip-centroids.csv

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

# Coolify health: the app answers 200 on / once the read-model is mounted.
# Entrypoint refreshes the read-model from R2 (best-effort), then serves.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
