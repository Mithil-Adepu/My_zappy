# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/app-api ./apps/app-api

# Generate Prisma client
RUN pnpm --filter @zapier-clone/db generate

# Build all dependencies then the app
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/app-api build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

RUN pnpm install --frozen-lockfile --prod

# Copy compiled output and prisma client
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/node_modules/.prisma ./packages/db/node_modules/.prisma
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/app-api/dist ./apps/app-api/dist

# Prisma schema for migrations at runtime
COPY packages/db/prisma ./packages/db/prisma

EXPOSE 3001

CMD ["node", "apps/app-api/dist/server.js"]
