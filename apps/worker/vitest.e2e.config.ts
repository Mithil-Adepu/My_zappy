import { defineConfig } from 'vitest/config';

// E2E test config — requires full docker-compose stack
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
  },
});
