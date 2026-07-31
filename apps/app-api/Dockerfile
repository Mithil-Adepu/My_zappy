# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm config set node-linker hoisted && pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/app-api ./apps/app-api

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/app-api build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Required by Prisma engine on Alpine
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

# Copy hoisted node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Inject workspace packages directly into node_modules so Node.js can resolve
# @zapier-clone/db and @zapier-clone/types (pnpm symlinks break in multi-stage builds)
COPY --from=builder /app/packages/db/dist ./node_modules/@zapier-clone/db/dist
COPY packages/db/package.json ./node_modules/@zapier-clone/db/package.json
COPY --from=builder /app/packages/types/dist ./node_modules/@zapier-clone/types/dist
COPY packages/types/package.json ./node_modules/@zapier-clone/types/package.json

COPY --from=builder /app/apps/app-api/dist ./apps/app-api/dist
COPY packages/db/prisma ./packages/db/prisma

EXPOSE 3001

CMD ["sh", "-c", "node node_modules/.bin/prisma migrate deploy --schema=packages/db/prisma/schema.prisma && node apps/app-api/dist/server.js"]
