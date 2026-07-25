# syntax=docker/dockerfile:1

# Build from the monorepo root:
#   docker build -f apps/docs/Dockerfile -t uxfront-docs .
# Dokploy: Build Type "Dockerfile", Docker File "apps/docs/Dockerfile",
# Docker Context Path ".", container port 3000.

FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NUXT_TELEMETRY_DISABLED=1
RUN corepack enable

WORKDIR /app
COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @uxfront/docs

# The prerenderer needs more heap than node's default in memory-limited containers.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @uxfront/docs run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app/apps/docs
# chown: Nuxt Content creates its SQLite database inside .output/server at runtime.
COPY --from=build --chown=node:node /app/apps/docs/.output ./.output
USER node

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
