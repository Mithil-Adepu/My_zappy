# ZapFlow Makefile
# ─────────────────────────────────────────────────────────────────────────────
# Windows users: install GNU Make first:
#   winget install GnuWin32.Make
# Then add  C:\Program Files (x86)\GnuWin32\bin  to your PATH.
# Alternatively use the pnpm script equivalents shown in the README.
# ─────────────────────────────────────────────────────────────────────────────

.PHONY: help install infra-up infra-down infra-logs infra-status \
        db-migrate db-seed db-reset db-studio \
        dev build docker-build docker-up docker-down docker-logs clean

# ─── Default ─────────────────────────────────────────────────────────────────
help: ## Show this help message
	$(info )
	$(info   ZapFlow -- available make targets:)
	$(info )
	$(info   SETUP)
	$(info     install          Install all pnpm dependencies)
	$(info )
	$(info   INFRASTRUCTURE  [Postgres, Redis, Kafka])
	$(info     infra-up         Start infra containers)
	$(info     infra-down       Stop all containers)
	$(info     infra-status     Show container health)
	$(info     infra-logs       Tail infra logs)
	$(info )
	$(info   DATABASE)
	$(info     db-migrate       Apply pending migrations)
	$(info     db-seed          Seed connector catalog)
	$(info     db-setup         migrate + seed in one step)
	$(info     db-reset         WARNING: drop DB and rebuild)
	$(info     db-studio        Open Prisma visual browser)
	$(info )
	$(info   DEV SERVICES  [each in its own terminal])
	$(info     dev              All services via Turborepo [parallel])
	$(info     dev-api          app-api only       :3001)
	$(info     dev-hooks        hooks-api only     :3002)
	$(info     dev-relay        relay only         :3003)
	$(info     dev-worker       worker only        :3004)
	$(info     dev-web          web [Next.js] only :3000)
	$(info )
	$(info   DOCKER  [full stack])
	$(info     docker-build     Build all images [with BuildKit cache])
	$(info     docker-up        Build + start full stack in Docker)
	$(info     docker-down      Stop all Docker containers)
	$(info     docker-logs      Tail all service logs)
	$(info )
	$(info   CONVENIENCE)
	$(info     start            Start infra + print dev instructions)
	$(info     build            TypeScript compile all packages)
	$(info     clean            Remove all dist/ folders)
	$(info     clean-all        Remove dist/ + node_modules)
	$(info )
	@exit 0

# ─── Setup ───────────────────────────────────────────────────────────────────
install: ## Install all dependencies
	pnpm install

# ─── Infrastructure (Postgres · Redis · Kafka) ────────────────────────────────
infra-up: ## Start infrastructure containers (Postgres, Redis, Kafka)
	docker compose up -d postgres redis kafka
	@echo ""
	@echo "  Waiting for containers to become healthy..."
	@echo "  Run 'make infra-status' to check."

infra-down: ## Stop and remove infrastructure containers
	docker compose down

infra-logs: ## Tail logs from infrastructure containers
	docker compose logs -f postgres redis kafka

infra-status: ## Show health status of all containers
	docker compose ps

# ─── Database ─────────────────────────────────────────────────────────────────
db-migrate: ## Apply all pending Prisma migrations
	pnpm --filter @zapier-clone/db db:migrate

db-seed: ## Seed the connector catalog
	pnpm --filter @zapier-clone/db db:seed

db-reset: ## ⚠️  Drop database and re-apply all migrations + seed
	pnpm --filter @zapier-clone/db db:reset

db-studio: ## Open Prisma Studio (visual DB browser)
	pnpm --filter @zapier-clone/db db:studio

db-setup: db-migrate db-seed ## Migrate + Seed in one step (use after infra-up)

# ─── Development ─────────────────────────────────────────────────────────────
dev: ## Start all services in dev mode (via Turborepo, parallel)
	pnpm dev

dev-api: ## Start only app-api in dev mode
	pnpm --filter @zapier-clone/app-api dev

dev-hooks: ## Start only hooks-api in dev mode
	pnpm --filter @zapier-clone/hooks-api dev

dev-relay: ## Start only relay in dev mode
	pnpm --filter @zapier-clone/relay dev

dev-worker: ## Start only worker in dev mode
	pnpm --filter @zapier-clone/worker dev

dev-web: ## Start only web (Next.js) in dev mode
	pnpm --filter @zapier-clone/web dev

# ─── Build ────────────────────────────────────────────────────────────────────
build: ## Build all packages/apps (TypeScript compile)
	pnpm build

# ─── Docker (full stack) ──────────────────────────────────────────────────────
docker-build: ## Build all Docker images (uses BuildKit cache)
	DOCKER_BUILDKIT=1 docker compose build

docker-up: ## Build images + start full stack in Docker (single command deploy)
	DOCKER_BUILDKIT=1 docker compose up --build -d
	@echo ""
	@echo "  Full stack started:"
	@echo "    Web        → http://localhost:3000"
	@echo "    App API    → http://localhost:3001"
	@echo "    Hooks API  → http://localhost:3002"
	@echo "    Relay      → http://localhost:3003 (health)"
	@echo "    Worker     → http://localhost:3004 (health)"
	@echo ""
	@echo "  Run 'make docker-logs' to follow logs."

docker-down: ## Stop all Docker containers
	docker compose down

docker-logs: ## Tail logs from all services
	docker compose logs -f

# ─── Full Dev Workflow (convenience) ─────────────────────────────────────────
start: infra-up ## Start infra, then print service start instructions
	@echo ""
	@echo "  Infrastructure is starting. Wait ~30s for Kafka to become healthy."
	@echo "  Then open 5 terminals and run:"
	@echo ""
	@echo "    make dev-api     (Terminal 1)"
	@echo "    make dev-hooks   (Terminal 2)"
	@echo "    make dev-relay   (Terminal 3)"
	@echo "    make dev-worker  (Terminal 4)"
	@echo "    make dev-web     (Terminal 5)"
	@echo ""
	@echo "  First time only, also run:  make db-setup"

# ─── Clean ────────────────────────────────────────────────────────────────────
clean: ## Remove all build artifacts (dist/ folders)
	powershell -Command "Get-ChildItem -Recurse -Directory -Filter dist | Where-Object { $_.FullName -notlike '*node_modules*' } | Remove-Item -Recurse -Force"

clean-all: clean ## Remove build artifacts + node_modules (full reset)
	powershell -Command "Get-ChildItem -Recurse -Directory -Filter node_modules | Where-Object { $_.FullName -notlike '*\.git*' } | Remove-Item -Recurse -Force"
