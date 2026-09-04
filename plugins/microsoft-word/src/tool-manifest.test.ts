import { describe, expect, it } from 'vitest';
import plugin from './index.js';

/**
 * The MCP server rejects a plugin whose manifest breaks these limits, and it
 * rejects the *whole plugin* — every tool disappears, not just the offending
 * one. The build does not catch it, so without this test the failure surfaces
 * only as tools mysteriously missing at runtime.
 */
const MAX_DESCRIPTION_CHARS = 1000;

describe('tool manifest', () => {
  const tools = plugin.tools;

  it('registers every tool with a unique name', () => {
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(tools.map(t => [t.name, t] as const))('%s has a description within the manifest limit', (_name, tool) => {
    expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it.each(tools.map(t => [t.name, t] as const))('%s describes what it does', (_name, tool) => {
    expect(tool.description.trim().length).toBeGreaterThan(0);
    expect(tool.summary?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
