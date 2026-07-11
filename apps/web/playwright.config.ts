import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for ZapFlow E2E frontend tests.
 *
 * Requires:
 *  - Web app running at http://localhost:3000 (NEXT_PUBLIC_APP_API_URL=http://localhost:3001)
 *  - app-api running at http://localhost:3001
 *  - Full Docker Compose stack for DB/Kafka
 *
 * Run:
 *   docker compose up -d
 *   pnpm dev  # starts all apps
 *   npx pnpm --filter @zapier-clone/web test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,  // Run serially since tests share state
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Uncomment to start the dev server automatically:
  // webServer: {
  //   command: 'pnpm dev',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: true,
  // },
});
