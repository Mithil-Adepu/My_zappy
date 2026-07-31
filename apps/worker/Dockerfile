# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/worker/package.json ./apps/worker/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm config set node-linker hoisted && pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/worker ./apps/worker

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/worker build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/worker/package.json ./apps/worker/

COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/packages/db/dist ./node_modules/@zapier-clone/db/dist
COPY packages/db/package.json ./node_modules/@zapier-clone/db/package.json
COPY --from=builder /app/packages/types/dist ./node_modules/@zapier-clone/types/dist
COPY packages/types/package.json ./node_modules/@zapier-clone/types/package.json

COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

EXPOSE 3004

CMD ["node", "apps/worker/dist/main.js"]
