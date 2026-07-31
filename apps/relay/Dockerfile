# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/relay/package.json ./apps/relay/

# BuildKit cache mount for pnpm store — only re-downloads packages when
# pnpm-lock.yaml changes. Cuts install time from ~90s → ~5s on cache hit.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/relay ./apps/relay

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/relay build

RUN pnpm --filter @zapier-clone/relay deploy --prod /deploy

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

COPY --from=builder /deploy ./

EXPOSE 3003

CMD ["node", "dist/main.js"]
