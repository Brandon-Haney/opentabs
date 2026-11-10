import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node, whose fetch global the tests replace with a fake instance. This file also
 * keeps vitest from resolving the monorepo root config, whose include pattern covers only platform/.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
