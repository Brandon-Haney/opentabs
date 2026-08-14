import { defineConfig } from 'vitest/config';

/**
 * Tests run under jsdom, because almost everything this plugin does is DOM work
 * — `src/xml.ts` needs `DOMParser`, `XMLSerializer`, and `createTreeWalker`,
 * none of which Node provides.
 *
 * One rule follows from that: **assert on parsed structure, never on serialized
 * XML.** jsdom's serializer does not agree with Chrome's about namespace
 * prefixes, attribute order, or self-closing tags, so a snapshot of
 * `serializeXml()` output would pin jsdom's behaviour rather than the bytes the
 * plugin actually writes into a .pptx. Parse the result and assert on what it
 * contains.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
  },
});
