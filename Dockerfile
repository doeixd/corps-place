# Production image for the corps-place web app (Coolify / Docker).
#
# Serves SSR + page reads from the precomputed read-model (the small rm_* SQLite),
# so it needs NO tfjs/model and NO 3.6 GB relational DB on the request path. The
# read-model + media-cache DBs are NOT baked in — mount them at runtime
# (Coolify persistent volume) and point READ_MODEL_DB_URL at the read-model file.
#
#   READ_MODEL_DB_URL=file:/data/read-model.db   (with read-model.{a,b}.db + .active in /data)
#   media-cache.db at the path media-cache.ts expects (default sdk/media-cache.db or via env)
#
# Single stage on purpose: the runtime needs `sharp` (image proxy uses a runtime
# require) which pulls native @img/* siblings, so keeping node_modules is the
# reliable path. tfjs-node is intentionally never installed (sdk runtime deps are
# skipped; vite externalizes the @sdk training imports that the read-model path
# never executes).
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Toolchain for any native gyp fallback (sharp normally uses prebuilt @img binaries).
# curl is required by Coolify's container health check (zero-downtime deploys).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Install root deps only (NOT sdk/ — no tfjs-node). Cache-friendly: deps before source.
# Use `npm install` not `npm ci`: the committed lockfile (generated on Windows) is
# missing Linux-only optional deps for sharp (@emnapi/*), which makes `npm ci` reject
# it. `npm install` resolves the correct platform deps in the build.
COPY package.json package-lock.json ./
# --include=dev: build tools (vite, vite-plus, plugins) are devDependencies, and
# ENV NODE_ENV=production would otherwise make npm skip them. They're pruned again
# after the build for a lean runtime image.
RUN npm install --include=dev --no-audit --no-fund

# App source (sdk/src is included for @sdk/* imports; heavy sdk dirs are .dockerignored).
COPY . .

# Yearbooks over GitHub's 100 MB limit are committed as .partNNN slices; rebuild
# the full PDFs into public/yearbook before the static assets are baked in.
RUN node scripts/reassembleYearbooks.mjs

# Build the TanStack Start app -> .output/server, then drop dev-only deps (keeps
# runtime deps like sharp/effect/@libsql).
RUN npm run build \
 && npm prune --omit=dev

# Read-model distribution is via R2 (replaces Turso). The entrypoint pulls the
# read-model into the mounted /data volume on boot (scripts/pullReadModel.mjs),
# which needs the S3 client at runtime. Installed AFTER prune so it isn't dropped;
# --no-save keeps the root package.json (a read-only COPY) untouched.
RUN npm install --no-save --no-audit --no-fund @aws-sdk/client-s3@^3 \
 && chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

# Coolify health: the app answers 200 on / once the read-model is mounted.
# Entrypoint refreshes the read-model from R2 (best-effort), then serves.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
