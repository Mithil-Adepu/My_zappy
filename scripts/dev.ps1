#!/usr/bin/env pwsh
# dev.ps1 — Windows PowerShell dev startup helper
# ─────────────────────────────────────────────────────────────────────────────
# Starts all 5 ZapFlow services in separate PowerShell windows.
# Run from the project root:  .\scripts\dev.ps1
# ─────────────────────────────────────────────────────────────────────────────

$root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  ZapFlow Dev Starter" -ForegroundColor Cyan
Write-Host "  ───────────────────" -ForegroundColor Cyan
Write-Host ""

# Step 1: verify Docker infra
Write-Host "  [1/3] Checking Docker infra..." -ForegroundColor Yellow
$containers = docker compose -f "$root\docker-compose.yml" ps --format json 2>$null | ConvertFrom-Json
$postgres = $containers | Where-Object { $_.Service -eq "postgres" -and $_.Health -eq "healthy" }

if (-not $postgres) {
    Write-Host "  Docker infra not running — starting Postgres, Redis, Kafka..." -ForegroundColor Yellow
    docker compose -f "$root\docker-compose.yml" up -d postgres redis kafka
    Write-Host "  Waiting 40s for Kafka to become healthy..." -ForegroundColor Yellow
    Start-Sleep -Seconds 40
} else {
    Write-Host "  Docker infra already running." -ForegroundColor Green
}

Write-Host ""
Write-Host "  [2/3] Applying DB migrations + seed..." -ForegroundColor Yellow
pnpm --filter @zapier-clone/db db:migrate
pnpm --filter @zapier-clone/db db:seed

Write-Host ""
Write-Host "  [3/3] Starting services in separate terminals..." -ForegroundColor Yellow

$services = @(
    @{ Name = "app-api  :3001"; Filter = "@zapier-clone/app-api" },
    @{ Name = "hooks-api:3002"; Filter = "@zapier-clone/hooks-api" },
    @{ Name = "relay    :3003"; Filter = "@zapier-clone/relay" },
    @{ Name = "worker   :3004"; Filter = "@zapier-clone/worker" },
    @{ Name = "web      :3000"; Filter = "@zapier-clone/web" }
)

foreach ($svc in $services) {
    $cmd = "pnpm --filter $($svc.Filter) dev"
    Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd '$root'; $cmd" `
        -WindowStyle Normal
    Write-Host "  Started $($svc.Name)" -ForegroundColor Green
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "  All services started!" -ForegroundColor Green
Write-Host ""
Write-Host "    Web Dashboard  → http://localhost:3000" -ForegroundColor Cyan
Write-Host "    App API        → http://localhost:3001" -ForegroundColor Cyan
Write-Host "    Hooks API      → http://localhost:3002" -ForegroundColor Cyan
Write-Host "    Relay health   → http://localhost:3003/health" -ForegroundColor Cyan
Write-Host "    Worker health  → http://localhost:3004/health" -ForegroundColor Cyan
Write-Host ""
