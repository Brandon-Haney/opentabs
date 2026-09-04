import { defineConfig } from 'vitest/config';

/**
 * Tests default to Node; upstream classification, cascade memory, fingerprint,
 * probe runner and attachment progress relay need only the WHATWG
 * Response/Headers/AbortSignal globals. Files that exercise the page —
 * outlook-api.test.ts, tools/diagnose.test.ts, auth-candidates.test.ts
 * (localStorage MSAL entries, window.location, stubbed fetch) and
 * reload-marker.test.ts (sessionStorage, performance.timeOrigin) — opt into jsdom
 * with a per-file `@vitest-environment` docblock.
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
