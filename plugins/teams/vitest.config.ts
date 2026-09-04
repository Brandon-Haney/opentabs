import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node: the request layer under test (teams-api on top of the
 * SDK's fetchWithRetry) relies only on the WHATWG Response, Headers and
 * AbortSignal globals Node 22 provides. A test that needs a
 * document — the diagnose tool reads `window.location` through
 * `getCurrentUrl()` — opts into jsdom with a per-file
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
