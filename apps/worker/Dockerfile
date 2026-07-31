# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/worker/package.json ./apps/worker/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/worker ./apps/worker

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/worker build

RUN pnpm --filter @zapier-clone/worker deploy --prod /deploy

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

COPY --from=builder /deploy ./

EXPOSE 3004

CMD ["node", "dist/main.js"]
