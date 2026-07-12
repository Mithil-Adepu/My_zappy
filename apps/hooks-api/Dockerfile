# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/hooks-api/package.json ./apps/hooks-api/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/hooks-api ./apps/hooks-api

RUN pnpm --filter @zapier-clone/db generate
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/hooks-api build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/hooks-api/package.json ./apps/hooks-api/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/node_modules/.prisma ./packages/db/node_modules/.prisma
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/hooks-api/dist ./apps/hooks-api/dist

EXPOSE 3002

CMD ["node", "apps/hooks-api/dist/server.js"]
