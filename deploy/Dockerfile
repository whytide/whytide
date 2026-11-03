# The images of our own apps (alpha-p10-070): one file, one target each, `api`, `worker` and `web`,
# built from the repository root by scripts/images-build.sh (README.md "Images"). The build stage
# installs the lockfile's packages, then builds with no network; the api and the worker get the build
# with production dependencies only, the web Next.js's standalone output. Each is owned by root and
# run as the image's user `node`, on the read-only root file system with a writable /tmp that
# compose.yaml gives every app container. The base image is pinned by digest, and Prisma's schema
# engine by its SHA-256, both listed in images.md; nothing else is downloaded.

# The schema engine `prisma migrate deploy` runs, which the api starts with (images.md "Prisma's
# schema engine"): the engines commit of the installed Prisma, the platform, the SHA-256 of the
# download and of the binary. A Prisma update without a new pin fails the build.
ARG PRISMA_ENGINES_COMMIT=0edf323efd1d98336f3f0a68684b56f689b900d3
ARG SCHEMA_ENGINE_GZ_SHA256=b7210b525a6e592c0d5db7e7d48edbc0f334e14e212af7af11c0d4a8de755a31
ARG SCHEMA_ENGINE_SHA256=29557c21d47da6f1695ec1a747cb6c607dade5e44e8b3e4fa687bd4dc226956d

FROM node:26.12.0-trixie-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11 AS base
ENV CHECKPOINT_DISABLE=1 NEXT_TELEMETRY_DISABLED=1

FROM base AS schema-engine
ARG PRISMA_ENGINES_COMMIT
ARG SCHEMA_ENGINE_GZ_SHA256
ARG SCHEMA_ENGINE_SHA256
COPY deploy/images/schema-engine.ts /build/
RUN node /build/schema-engine.ts fetch "$PRISMA_ENGINES_COMMIT" "$SCHEMA_ENGINE_GZ_SHA256" \
      "$SCHEMA_ENGINE_SHA256" /opt/prisma/schema-engine

# pnpm: its native binary for linux/amd64, at the version package.json names, checked against the
# integrity the lockfile records for it; a stage of its own, so another change to package.json
# leaves the store below as it is.
FROM base AS pnpm
WORKDIR /pnpm
COPY package.json pnpm-lock.yaml ./
RUN set -eu; \
    version="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"; \
    package="@pnpm/exe.linux-x64@$version"; \
    expected="$(grep -A1 -m1 "^  '$package':\$" pnpm-lock.yaml | sed -n 's/.*integrity: \(sha512-[^}]*\)}.*/\1/p')"; \
    tarball="/tmp/$(npm pack --silent --pack-destination /tmp "$package")"; \
    actual="$(node -e 'const c = require("node:crypto"), f = require("node:fs"); console.log("sha512-" + c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"; \
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "$package: $actual, the lockfile says $expected" >&2; exit 1; }; \
    tar -xzf "$tarball" -C /usr/local/bin --strip-components 1 package/pnpm; \
    rm "$tarball"; \
    pnpm --version

FROM base AS build
ENV CI=true NEXT_DISABLE_SWC_WASM=1
WORKDIR /app
COPY --from=pnpm /usr/local/bin/pnpm /usr/local/bin/pnpm
# Every package of the lockfile into pnpm's store, from the lockfile alone: a change to the sources
# downloads nothing again.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# No network from here on: no install script runs (pnpm-workspace.yaml allows none; the root's
# prepare hook needs git), and Next.js finds its native compiler for this platform in the store.
RUN --network=none pnpm install --frozen-lockfile --offline --ignore-scripts
# Prisma's CLI runs on the pinned schema engine here too, which `prisma generate` would download.
COPY --from=schema-engine /opt/prisma/schema-engine /opt/prisma/schema-engine
ENV PRISMA_SCHEMA_ENGINE_BINARY=/opt/prisma/schema-engine
ARG PRISMA_ENGINES_COMMIT
RUN --network=none node deploy/images/schema-engine.ts check "$PRISMA_ENGINES_COMMIT"
# Where the web's server calls the api, built into the web by Next.js (core/apps/web/README.md "Run"):
# the api's name and port on the Compose network, the same on every server, since the browser calls
# /api on the page's own origin, which Caddy routes to the api.
ARG NEXT_PUBLIC_API_URL=http://api:3001
# One host at a time: the worker's build builds every module, which the hosts load from
# core/modules/<name>/dist; the web's builds the api's OpenAPI document and its client first, which
# loads the modules' configuration, as the pipeline does, under APP_ENV=development.
RUN --network=none pnpm -F @whytide/worker build && pnpm -F @whytide/api build && \
    APP_ENV=development pnpm -F @whytide/web build

# Production dependencies only, of the api, the worker and the modules, from the store, offline.
FROM build AS server
RUN --network=none rm -rf core/apps/web/.next && \
    find . -name node_modules -type d -prune -exec rm -rf {} + && \
    pnpm install --frozen-lockfile --ignore-scripts --offline --prod \
      --filter "@whytide/api..." --filter "@whytide/worker..." --filter "./core/modules/*..."

FROM base AS runtime
ENV NODE_ENV=production PRISMA_SCHEMA_ENGINE_BINARY=/opt/prisma/schema-engine
COPY --from=schema-engine --chmod=555 /opt/prisma/schema-engine /opt/prisma/schema-engine
COPY --from=server /app /app
USER node

FROM runtime AS api
WORKDIR /app/core/apps/api
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 CMD ["node", "-e", \
  "fetch(`http://127.0.0.1:${process.env.API_PORT || 3001}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/src/main.js"]

FROM runtime AS worker
WORKDIR /app/core/apps/worker
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 CMD ["node", "-e", \
  "fetch(`http://127.0.0.1:${process.env.WORKER_HEALTH_PORT || 3002}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]

# Next.js's standalone server and its static files, nothing else of the repository; it listens on
# 3000 in its container.
FROM base AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/core/apps/web/.next/standalone /app
COPY --from=build /app/core/apps/web/.next/static /app/core/apps/web/.next/static
USER node
WORKDIR /app/core/apps/web
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD ["node", "-e", \
  "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
