# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/hooks-api/package.json ./apps/hooks-api/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/hooks-api ./apps/hooks-api

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/hooks-api build

RUN pnpm --filter @zapier-clone/hooks-api deploy --prod /deploy
COPY packages/db/prisma /deploy/packages/db/prisma
RUN cd /deploy && ./node_modules/.bin/prisma generate --schema=packages/db/prisma/schema.prisma

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

COPY --from=builder /deploy ./

EXPOSE 3002

CMD ["node", "dist/server.js"]
