import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Integration tests (docker-required) are excluded from the default test run
    exclude: ['src/**/*.integration.test.ts'],
  },
});
