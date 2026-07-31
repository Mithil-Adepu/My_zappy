# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/web ./apps/web

# Build Next.js — produces apps/web/.next/standalone for the runner stage
RUN pnpm --filter @zapier-clone/web build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Next.js standalone output bundles only the necessary files.
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy the standalone server (includes all required node_modules inline)
COPY --from=builder /app/apps/web/.next/standalone ./
# Copy the static assets (JS chunks, images, fonts)
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# Copy public assets (favicon, robots.txt, etc.)
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/web/server.js"]
