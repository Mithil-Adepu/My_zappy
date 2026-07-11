## ─── ZapFlow — Developer Makefile ─────────────────────────────────────────────
##
## Usage:
##   make infra-up      — Start Postgres, Redis, Kafka (Docker)
##   make infra-down    — Stop all infra containers
##   make db-migrate    — Apply Prisma migrations
##   make db-seed       — Seed connector catalog
##   make db-reset      — Drop + re-migrate + seed (dev only)
##   make dev           — Start all services in parallel
##   make test          — Run all unit tests
##   make typecheck     — TypeScript type check all packages
##   make install       — Install all pnpm dependencies
##

PNPM := $(shell which pnpm 2>/dev/null || echo ~/.local/bin/pnpm)
DOCKER_COMPOSE := $(shell ls ~/.docker/cli-plugins/docker-compose 2>/dev/null && echo "docker --config ~/.docker compose" || echo "docker-compose")

# ─── Colors ───────────────────────────────────────────────────────────────────
GREEN  := \033[32m
YELLOW := \033[33m
CYAN   := \033[36m
RESET  := \033[0m

.PHONY: help
help:
	@echo ""
	@echo "  $(CYAN)ZapFlow Developer Commands$(RESET)"
	@echo ""
	@echo "  $(GREEN)make infra-up$(RESET)     — Start Postgres, Redis, Kafka"
	@echo "  $(GREEN)make infra-down$(RESET)   — Stop all infra containers"
	@echo "  $(GREEN)make db-migrate$(RESET)   — Apply Prisma migrations"
	@echo "  $(GREEN)make db-seed$(RESET)      — Seed connector catalog"
	@echo "  $(GREEN)make db-reset$(RESET)     — Drop + re-migrate + seed"
	@echo "  $(GREEN)make dev$(RESET)          — Start all 4 services"
	@echo "  $(GREEN)make test$(RESET)         — Run all unit tests"
	@echo "  $(GREEN)make typecheck$(RESET)    — TypeScript check"
	@echo "  $(GREEN)make install$(RESET)      — pnpm install"
	@echo ""

# ─── Install ──────────────────────────────────────────────────────────────────
.PHONY: install
install:
	@echo "$(CYAN)→ Installing dependencies...$(RESET)"
	$(PNPM) install

# ─── Infrastructure ───────────────────────────────────────────────────────────
.PHONY: infra-up
infra-up:
	@echo "$(CYAN)→ Starting Postgres, Redis, Kafka...$(RESET)"
	export PATH="$$PATH:/Applications/Docker.app/Contents/Resources/bin:$$HOME/.docker/bin" && \
	  docker compose -f docker-compose.yml up -d
	@echo "$(GREEN)✓ Infra running. Waiting for Postgres to be ready...$(RESET)"
	@sleep 3
	@echo "$(GREEN)✓ Ready!$(RESET)"

.PHONY: infra-down
infra-down:
	export PATH="$$PATH:/Applications/Docker.app/Contents/Resources/bin:$$HOME/.docker/bin" && \
	  docker compose -f docker-compose.yml down

.PHONY: infra-logs
infra-logs:
	export PATH="$$PATH:/Applications/Docker.app/Contents/Resources/bin:$$HOME/.docker/bin" && \
	  docker compose -f docker-compose.yml logs -f

# ─── Database ─────────────────────────────────────────────────────────────────
.PHONY: db-migrate
db-migrate:
	@echo "$(CYAN)→ Applying migrations...$(RESET)"
	$(PNPM) --filter @zapier-clone/db db:migrate
	@echo "$(GREEN)✓ Migrations applied$(RESET)"

.PHONY: db-seed
db-seed:
	@echo "$(CYAN)→ Seeding connector catalog...$(RESET)"
	$(PNPM) --filter @zapier-clone/db db:seed
	@echo "$(GREEN)✓ Connectors seeded$(RESET)"

.PHONY: db-reset
db-reset:
	@echo "$(YELLOW)⚠ Resetting database (dev only)...$(RESET)"
	$(PNPM) --filter @zapier-clone/db prisma migrate reset --force
	$(PNPM) --filter @zapier-clone/db db:seed

# ─── Development servers ──────────────────────────────────────────────────────
.PHONY: dev
dev:
	@echo "$(CYAN)→ Starting all services in parallel...$(RESET)"
	@echo "$(YELLOW)  Tip: Run 'make infra-up' first if infra isn't running$(RESET)"
	$(PNPM) --parallel -r dev 2>&1

.PHONY: dev-api
dev-api:
	$(PNPM) --filter @zapier-clone/app-api dev

.PHONY: dev-hooks
dev-hooks:
	$(PNPM) --filter @zapier-clone/hooks-api dev

.PHONY: dev-relay
dev-relay:
	$(PNPM) --filter @zapier-clone/relay dev

.PHONY: dev-worker
dev-worker:
	$(PNPM) --filter @zapier-clone/worker dev

.PHONY: dev-web
dev-web:
	$(PNPM) --filter @zapier-clone/web dev

# ─── Tests ────────────────────────────────────────────────────────────────────
.PHONY: test
test:
	@echo "$(CYAN)→ Running unit tests...$(RESET)"
	$(PNPM) --filter @zapier-clone/worker test
	$(PNPM) --filter @zapier-clone/hooks-api test
	@echo "$(GREEN)✓ All tests passed$(RESET)"

.PHONY: test-watch
test-watch:
	$(PNPM) --filter @zapier-clone/worker test:watch

# ─── Type check ───────────────────────────────────────────────────────────────
.PHONY: typecheck
typecheck:
	@echo "$(CYAN)→ Running type check...$(RESET)"
	$(PNPM) --filter "@zapier-clone/*" lint
	@echo "$(GREEN)✓ No type errors$(RESET)"

# ─── Generate Prisma client ───────────────────────────────────────────────────
.PHONY: prisma-generate
prisma-generate:
	$(PNPM) --filter @zapier-clone/db generate
