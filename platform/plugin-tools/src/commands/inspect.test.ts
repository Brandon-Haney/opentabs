import { extractFields, handleInspect, truncate } from './inspect.js';
import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolsJsonManifest } from './inspect.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'opentabs-inspect-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a valid tools.json manifest to tmpDir/dist/tools.json */
const writeToolsJson = async (manifest: ToolsJsonManifest): Promise<void> => {
  mkdirSync(join(tmpDir, 'dist'), { recursive: true });
  await writeFile(join(tmpDir, 'dist', 'tools.json'), JSON.stringify(manifest), 'utf-8');
};

/** Write a valid package.json to tmpDir/package.json */
const writePackageJson = async (pkg: Record<string, unknown>): Promise<void> => {
  await writeFile(join(tmpDir, 'package.json'), JSON.stringify(pkg), 'utf-8');
};

/** A sample tool for use in test manifests */
const sampleTool = {
  name: 'send_message',
  displayName: 'Send Message',
  description: 'Send a message to a channel',
  icon: 'mail',
  input_schema: {
    type: 'object',
    properties: { channel: { type: 'string' }, text: { type: 'string' } },
    required: ['channel', 'text'],
  },
  output_schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
} as const;

/** A minimal valid tools.json manifest with one tool */
const minimalManifest: ToolsJsonManifest = {
  tools: [sampleTool],
};

/** A valid package.json for a plugin */
const validPackageJson = {
  name: 'opentabs-plugin-test',
  version: '1.2.3',
  main: 'dist/adapter.iife.js',
  opentabs: {
    displayName: 'Test Plugin',
    description: 'A test plugin',
    urlPatterns: ['https://example.com/*'],
  },
};

/**
 * Capture console.log and console.error output while running an async function.
 * Also intercepts process.exit to prevent the test runner from exiting.
 */
const captureOutput = async (
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; exitCode: number | null }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origExit = process.exit.bind(process);

  console.log = vi.fn((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  console.error = vi.fn((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  process.exit = vi.fn((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${String(code)})`);
  }) as never;

  try {
    await fn();
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.startsWith('process.exit(')) {
      throw e;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { logs, errors, exitCode };
};

// ---------------------------------------------------------------------------
// extractFields
// ---------------------------------------------------------------------------

describe('extractFields', () => {
  test('extracts simple typed properties with required status', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
    };
    const fields = extractFields(schema);
    expect(fields).toEqual([
      { name: 'name', type: 'string', required: true },
      { name: 'age', type: 'number', required: false },
    ]);
  });

  test('returns empty array when schema has no properties', () => {
    expect(extractFields({})).toEqual([]);
    expect(extractFields({ type: 'object' })).toEqual([]);
  });

  test('handles anyOf union types', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const fields = extractFields(schema);
    expect(fields).toEqual([{ name: 'value', type: 'string | number', required: false }]);
  });

  test('uses unknown for properties without type or anyOf', () => {
    const schema = {
      type: 'object',
      properties: { data: {} },
    };
    const fields = extractFields(schema);
    expect(fields).toEqual([{ name: 'data', type: 'unknown', required: false }]);
  });

  test('handles anyOf with non-typed members', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { const: null }] },
      },
    };
    const fields = extractFields(schema);
    expect(fields).toEqual([{ name: 'value', type: 'string | ?', required: false }]);
  });

  test('treats required as empty when not an array', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: 'name',
    };
    const fields = extractFields(schema);
    expect(fields).toEqual([{ name: 'name', type: 'string', required: false }]);
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  test('returns string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('returns string unchanged when exactly maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  test('truncates and appends ... when longer than maxLen', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  test('handles maxLen of 3 (minimum for truncation)', () => {
    expect(truncate('abcd', 3)).toBe('...');
  });

  test('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// handleInspect — missing manifest
// ---------------------------------------------------------------------------

describe('handleInspect — missing manifest', () => {
  test('exits with error when dist/tools.json does not exist', async () => {
    const { errors, exitCode } = await captureOutput(() => handleInspect({}, tmpDir));
    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('No manifest found'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleInspect — invalid manifest
// ---------------------------------------------------------------------------

describe('handleInspect — invalid manifest', () => {
  test('exits with error when dist/tools.json is invalid JSON', async () => {
    mkdirSync(join(tmpDir, 'dist'), { recursive: true });
    await writeFile(join(tmpDir, 'dist', 'tools.json'), '{not valid json', 'utf-8');
    const { errors, exitCode } = await captureOutput(() => handleInspect({}, tmpDir));
    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('Failed to parse'))).toBe(true);
  });

  test('exits with error when dist/tools.json is not an object', async () => {
    mkdirSync(join(tmpDir, 'dist'), { recursive: true });
    await writeFile(join(tmpDir, 'dist', 'tools.json'), '"just a string"', 'utf-8');
    const { errors, exitCode } = await captureOutput(() => handleInspect({}, tmpDir));
    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('Failed to parse'))).toBe(true);
  });

  test('exits with error when manifest object has no tools array', async () => {
    mkdirSync(join(tmpDir, 'dist'), { recursive: true });
    await writeFile(join(tmpDir, 'dist', 'tools.json'), JSON.stringify({ version: '1.0' }), 'utf-8');
    const { errors, exitCode } = await captureOutput(() => handleInspect({}, tmpDir));
    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('Failed to parse'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleInspect — JSON output mode
// ---------------------------------------------------------------------------

describe('handleInspect — JSON output mode', () => {
  test('outputs raw JSON with --json flag', async () => {
    await writeToolsJson(minimalManifest);
    const { logs, exitCode } = await captureOutput(() => handleInspect({ json: true }, tmpDir));
    expect(exitCode).toBeNull();
    const parsed: unknown = JSON.parse(logs.join('\n'));
    expect(parsed).toEqual(minimalManifest);
  });

  test('outputs manifest with resources and prompts in JSON mode', async () => {
    const manifest: ToolsJsonManifest = {
      sdkVersion: '0.0.20',
      tools: minimalManifest.tools,
      resources: [{ uri: 'test://items', name: 'Items', description: 'All items', mimeType: 'application/json' }],
      prompts: [{ name: 'greet', description: 'Greet someone', arguments: [{ name: 'name', required: true }] }],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({ json: true }, tmpDir));
    const parsed: unknown = JSON.parse(logs.join('\n'));
    expect(parsed).toEqual(manifest);
  });
});

// ---------------------------------------------------------------------------
// handleInspect — formatted output with tools
// ---------------------------------------------------------------------------

describe('handleInspect — formatted output', () => {
  test('displays tool name, description, and input/output fields', async () => {
    await writeToolsJson(minimalManifest);
    await writePackageJson(validPackageJson);
    const { logs, exitCode } = await captureOutput(() => handleInspect({}, tmpDir));
    expect(exitCode).toBeNull();
    const output = logs.join('\n');
    expect(output).toContain('send_message');
    expect(output).toContain('Send a message to a channel');
    expect(output).toContain('channel: string');
    expect(output).toContain('text: string');
    expect(output).toContain('ok: boolean');
  });

  test('displays plugin name and version from package.json', async () => {
    await writeToolsJson(minimalManifest);
    await writePackageJson(validPackageJson);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('Test Plugin');
    expect(output).toContain('v1.2.3');
  });

  test('displays SDK version when present in manifest', async () => {
    await writeToolsJson({ ...minimalManifest, sdkVersion: '0.0.20' });
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('SDK version: 0.0.20');
  });

  test('displays (unknown) when package.json is missing', async () => {
    await writeToolsJson(minimalManifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('(unknown)');
  });

  test('displays summary counts for tools, resources, and prompts', async () => {
    await writeToolsJson(minimalManifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('1 tool');
    expect(output).toContain('0 resources');
    expect(output).toContain('0 prompts');
  });

  test('pluralizes correctly for multiple items', async () => {
    const manifest: ToolsJsonManifest = {
      tools: [sampleTool, sampleTool],
      resources: [
        { uri: 'a://1', name: 'R1' },
        { uri: 'a://2', name: 'R2' },
      ],
      prompts: [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('2 tools');
    expect(output).toContain('2 resources');
    expect(output).toContain('3 prompts');
  });
});

// ---------------------------------------------------------------------------
// handleInspect — resources display
// ---------------------------------------------------------------------------

describe('handleInspect — resources display', () => {
  test('displays resource URI, name, description, and MIME type', async () => {
    const manifest: ToolsJsonManifest = {
      tools: minimalManifest.tools,
      resources: [
        {
          uri: 'slack://channels',
          name: 'Channels',
          description: 'List of Slack channels',
          mimeType: 'application/json',
        },
      ],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('Resources');
    expect(output).toContain('slack://channels');
    expect(output).toContain('Channels');
    expect(output).toContain('List of Slack channels');
    expect(output).toContain('MIME: application/json');
  });

  test('omits description and MIME lines when not present', async () => {
    const manifest: ToolsJsonManifest = {
      tools: minimalManifest.tools,
      resources: [{ uri: 'test://data', name: 'Data' }],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('test://data');
    expect(output).toContain('Data');
    expect(output).not.toContain('MIME:');
  });
});

// ---------------------------------------------------------------------------
// handleInspect — prompts display
// ---------------------------------------------------------------------------

describe('handleInspect — prompts display', () => {
  test('displays prompt name, description, and argument metadata', async () => {
    const manifest: ToolsJsonManifest = {
      tools: minimalManifest.tools,
      prompts: [
        {
          name: 'greet',
          description: 'Greet someone',
          arguments: [
            { name: 'name', description: 'Who to greet', required: true },
            { name: 'style', description: 'Greeting style', required: false },
          ],
        },
      ],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('Prompts');
    expect(output).toContain('greet');
    expect(output).toContain('Greet someone');
    expect(output).toContain('Args:');
    expect(output).toContain('name');
    expect(output).toContain('Who to greet');
    expect(output).toContain('style?');
  });

  test('omits description and args lines when not present', async () => {
    const manifest: ToolsJsonManifest = {
      tools: minimalManifest.tools,
      prompts: [{ name: 'simple' }],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).toContain('simple');
    expect(output).not.toContain('Args:');
  });
});

// ---------------------------------------------------------------------------
// handleInspect — tool description truncation
// ---------------------------------------------------------------------------

describe('handleInspect — tool description truncation', () => {
  test('truncates long tool descriptions to 80 characters', async () => {
    const longDescription = 'A'.repeat(100);
    const manifest: ToolsJsonManifest = {
      tools: [{ ...sampleTool, description: longDescription }],
    };
    await writeToolsJson(manifest);
    const { logs } = await captureOutput(() => handleInspect({}, tmpDir));
    const output = logs.join('\n');
    expect(output).not.toContain(longDescription);
    expect(output).toContain('...');
  });
});
