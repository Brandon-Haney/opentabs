import { defineConfig } from 'vitest/config';

/**
 * Tests run in Node by default (tool-manifest.test.ts inspects the plugin's
 * tool definitions). A test that needs `localStorage` — onenote-api.test.ts and
 * tools/diagnose.test.ts exercise the token-source readers — opts into jsdom
 * with a per-file `@vitest-environment jsdom` docblock. The shared Microsoft
 * modules (microsoft-upstream.ts, diagnostics.ts) are byte-identical copies of
 * plugins/outlook/src and are tested there.
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
