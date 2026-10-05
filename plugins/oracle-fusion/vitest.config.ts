import { defineConfig } from 'vitest/config';

/**
 * The protocol and query-panel parsers read server-rendered HTML through
 * `DOMParser`, so their tests run under jsdom.
 *
 * This file also keeps vitest from resolving the monorepo root config, whose
 * include pattern covers only platform/.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
  },
});
