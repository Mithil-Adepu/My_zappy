import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Integration tests and the engine executor test require extra heap — run separately
    exclude: [
      'src/**/*.integration.test.ts',
      'src/engine/__tests__/sequential-executor.test.ts',
    ],
  },
});

