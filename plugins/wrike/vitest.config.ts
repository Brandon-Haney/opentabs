import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node, which provides the Blob, FormData and atob globals the
 * attachment upload builds on. This file also keeps vitest from resolving the
 * monorepo root config, whose include pattern covers only platform/.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
