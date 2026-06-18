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
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Native toolchain for sharp and any native gyp fallback
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install ALL deps (dev + prod) — cache-friendly: deps before source
COPY package.json pnpm-lock.yaml .npmrc ./
ENV PNPM_STORE_DIR=/root/.pnpm-store
RUN --mount=type=cache,target=/root/.pnpm-store \
 pnpm install --frozen-lockfile

# App source (sdk/src is included for @sdk/* imports; heavy sdk dirs are .dockerignored)
COPY . .
RUN npm run build

# ============================================================
# Production: slim image with only runtime deps + build output
# ============================================================
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Only what the runtime actually needs: curl+wget (health check), ca-certificates (HTTPS)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl wget \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install production deps only — no TypeScript, puppeteer, vite etc.
COPY package.json pnpm-lock.yaml .npmrc ./
ENV PNPM_STORE_DIR=/root/.pnpm-store
RUN --mount=type=cache,target=/root/.pnpm-store \
 pnpm install --prod --frozen-lockfile

# Build output + entrypoint + R2 pull script (from builder)
COPY --from=builder /app/.output .output
COPY --from=builder /app/docker-entrypoint.sh docker-entrypoint.sh
COPY --from=builder /app/scripts/pullReadModel.mjs scripts/pullReadModel.mjs
COPY --from=builder /app/scripts/pullMediaCache.mjs scripts/pullMediaCache.mjs

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

# Coolify health: the app answers 200 on / once the read-model is mounted.
# Entrypoint refreshes the read-model from R2 (best-effort), then serves.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
