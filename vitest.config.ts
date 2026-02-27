import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
  },
});
