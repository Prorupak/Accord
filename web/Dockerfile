# syntax=docker/dockerfile:1
# Build from the repo root: app/page.tsx reads ../fixtures/inventory at build time.
#   docker build -f web/Dockerfile .
ARG NODE_IMAGE=node:24.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl lets the @prisma/engines install script pick the right schema-engine build for `migrate`.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate
WORKDIR /repo/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
# Rewrites are resolved at build time, so the proxy target is baked into the routes manifest.
ARG ACCORD_API_ORIGIN=http://api:8000
ENV ACCORD_API_ORIGIN=${ACCORD_API_ORIGIN} \
    NEXT_OUTPUT_STANDALONE=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY fixtures /repo/fixtures
COPY web ./
# `pnpm build` runs `prisma generate` first; that needs the schema only, never a DATABASE_URL.
RUN pnpm build

# One-off migration runner (compose.db.yaml `migrate`): applies the committed SQL and exits.
FROM deps AS migrate
COPY web/prisma.config.ts ./
COPY web/prisma ./prisma
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./.next/static
COPY --from=build /repo/web/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
