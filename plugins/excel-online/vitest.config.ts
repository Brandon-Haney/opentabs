import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node by default: token introspection and the tool manifest
 * need no browser globals. A test that needs a document — the request layer
 * reads tokens from localStorage and the page URL, and the tools under test
 * run against that layer — opts into jsdom with a per-file
 * `@vitest-environment jsdom` docblock.
 *
 * This file also keeps vitest from resolving the monorepo root config, whose
 * include pattern covers only platform/.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
