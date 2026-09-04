import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node by default: the request-budget timing suite relies only
 * on the WHATWG Response, Headers, AbortSignal and DOMException globals Node
 * 22 provides in one realm. Tests that need a document — localStorage for
 * token sources, sessionStorage and performance.timeOrigin for the reload
 * marker — opt into jsdom with a per-file `@vitest-environment jsdom`
 * docblock.
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
