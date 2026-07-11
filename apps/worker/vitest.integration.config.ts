import { defineConfig } from 'vitest/config';

// Integration tests config — includes *.integration.test.ts files
// Requires Docker to be running (Testcontainers spins up Postgres)
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120_000,
  },
});
