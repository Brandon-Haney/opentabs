import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { McpCallbacks } from './extension-handlers.js';
import {
  handleConfigGetState,
  handleConfigSetPluginPermission,
  handleConfigSetToolPermission,
  handleConfirmationResponse,
  handlePluginLog,
  handlePluginRemove,
  handleTabStateChanged,
  handleTabSyncAll,
  handleToolProgress,
  rejectAllPendingConfirmations,
} from './extension-handlers.js';
import { clearAllLogs, getLogs } from './log-buffer.js';
import type { PendingConfirmation, PendingDispatch, RegisteredPlugin } from './state.js';
import { createState, DISPATCH_TIMEOUT_MS, MAX_DISPATCH_TIMEOUT_MS } from './state.js';

vi.mock('./plugin-management.js', () => ({
  searchNpmPlugins: vi.fn().mockResolvedValue([]),
  installPlugin: vi.fn().mockResolvedValue({ ok: true }),
  updatePlugin: vi.fn().mockResolvedValue({ ok: true }),
  removePlugin: vi.fn().mockResolvedValue({ ok: true }),
  checkPluginUpdates: vi.fn().mockResolvedValue([]),
}));

/** Create a tracked PendingConfirmation that records resolve/reject calls */
const createPendingConfirmation = (
  overrides?: Partial<PendingConfirmation>,
): PendingConfirmation & { resolved: unknown; rejected: unknown } => {
  const result: PendingConfirmation & { resolved: unknown; rejected: unknown } = {
    resolved: undefined as unknown,
    rejected: undefined as unknown,
    resolve: decision => {
      result.resolved = decision;
    },
    reject: (err: Error) => {
      result.rejected = err;
    },
    tool: 'slack_send_message',
    plugin: 'slack',
    params: {},
    ...overrides,
  };
  return result;
};

/** No-op MCP callbacks */
const noopCallbacks: McpCallbacks = {
  onToolConfigChanged: () => {},
  onPluginPermissionsPersist: () => {},
  onPluginLog: () => {},
  onReload: () => Promise.resolve({ plugins: 0, durationMs: 0 }),
  queryExtension: () => Promise.resolve(undefined),
};

describe('handleConfirmationResponse', () => {
  test('allow resolves the pending confirmation', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-1', pending);

    handleConfirmationResponse(state, { id: 'conf-1', decision: 'allow' });

    expect(pending.resolved).toEqual({ action: 'allow', alwaysAllow: false });
    expect(state.pendingConfirmations.has('conf-1')).toBe(false);
  });

  test('deny resolves the pending confirmation with deny', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-2', pending);

    handleConfirmationResponse(state, { id: 'conf-2', decision: 'deny' });

    expect(pending.resolved).toEqual({ action: 'deny', alwaysAllow: false });
    expect(state.pendingConfirmations.has('conf-2')).toBe(false);
  });

  test('unknown id is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-3', pending);

    handleConfirmationResponse(state, { id: 'nonexistent', decision: 'allow' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-3')).toBe(true);
  });

  test('missing params is silently ignored', () => {
    const state = createState();
    handleConfirmationResponse(state, undefined);
    expect(state.pendingConfirmations.size).toBe(0);
  });

  test('invalid decision value is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-7', pending);

    handleConfirmationResponse(state, { id: 'conf-7', decision: 'invalid' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-7')).toBe(true);
  });

  test('non-string id is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-8', pending);

    handleConfirmationResponse(state, { id: 123, decision: 'allow' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-8')).toBe(true);
  });
});

describe('handleToolProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('forwards progress to onProgress callback', () => {
    const state = createState();
    let receivedProgress: { progress: number; total: number; message?: string } | undefined;
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
      onProgress: (progress, total, message) => {
        receivedProgress = { progress, total, message };
      },
    };
    state.pendingDispatches.set('dispatch-1', pending);

    handleToolProgress(state, { dispatchId: 'dispatch-1', progress: 5, total: 10, message: 'Step 5' });

    expect(receivedProgress).toBeDefined();
    expect(receivedProgress?.progress).toBe(5);
    expect(receivedProgress?.total).toBe(10);
    expect(receivedProgress?.message).toBe('Step 5');

    clearTimeout(pending.timerId);
  });

  test('updates lastProgressTs on the pending dispatch', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-2', pending);

    expect(pending.lastProgressTs).toBeUndefined();

    handleToolProgress(state, { dispatchId: 'dispatch-2', progress: 1, total: 5 });

    expect(pending.lastProgressTs).toBeDefined();
    expect(typeof pending.lastProgressTs).toBe('number');

    clearTimeout(pending.timerId);
  });

  test('resets the dispatch timeout timer on progress', () => {
    const state = createState();
    let rejected: Error | undefined;
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: err => {
        rejected = err;
      },
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-3', pending);

    // Advance close to timeout
    vi.advanceTimersByTime(DISPATCH_TIMEOUT_MS - 5_000);
    expect(state.pendingDispatches.has('dispatch-3')).toBe(true);

    // Send progress — this should reset the timer
    handleToolProgress(state, { dispatchId: 'dispatch-3', progress: 1, total: 10 });

    // Advance past the original timeout — dispatch should still be alive
    vi.advanceTimersByTime(10_000);
    expect(state.pendingDispatches.has('dispatch-3')).toBe(true);
    expect(rejected).toBeUndefined();

    // Advance to trigger the new timeout (DISPATCH_TIMEOUT_MS from progress)
    vi.advanceTimersByTime(DISPATCH_TIMEOUT_MS);
    expect(state.pendingDispatches.has('dispatch-3')).toBe(false);
    expect(rejected).toBeDefined();
    expect(rejected?.message).toContain('timed out');
  });

  test('rejects immediately when elapsed exceeds MAX_DISPATCH_TIMEOUT_MS', () => {
    const state = createState();
    let rejected: Error | undefined;
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: err => {
        rejected = err;
      },
      label: 'test/forever',
      startTs: Date.now() - MAX_DISPATCH_TIMEOUT_MS - 1_000,
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-4', pending);

    handleToolProgress(state, { dispatchId: 'dispatch-4', progress: 1, total: 10 });

    expect(state.pendingDispatches.has('dispatch-4')).toBe(false);
    expect(rejected).toBeDefined();
    expect(rejected?.message).toContain('absolute max timeout');
    expect(rejected?.message).toContain(`${MAX_DISPATCH_TIMEOUT_MS}ms`);
  });

  test('missing dispatchId is silently ignored', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-5', pending);

    handleToolProgress(state, { progress: 1, total: 5 });

    expect(pending.lastProgressTs).toBeUndefined();
    clearTimeout(pending.timerId);
  });

  test('invalid dispatchId type is silently ignored', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-6', pending);

    handleToolProgress(state, { dispatchId: 123, progress: 1, total: 5 });

    expect(pending.lastProgressTs).toBeUndefined();
    clearTimeout(pending.timerId);
  });

  test('unknown dispatchId is silently ignored', () => {
    const state = createState();

    handleToolProgress(state, { dispatchId: 'nonexistent', progress: 1, total: 5 });

    expect(state.pendingDispatches.size).toBe(0);
  });

  test('missing params is silently ignored', () => {
    const state = createState();

    handleToolProgress(state, undefined);

    expect(state.pendingDispatches.size).toBe(0);
  });

  test('invalid progress/total types are silently ignored', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-7', pending);

    handleToolProgress(state, { dispatchId: 'dispatch-7', progress: 'five', total: 'ten' });

    expect(pending.lastProgressTs).toBeUndefined();
    clearTimeout(pending.timerId);
  });

  test('onProgress callback error does not break tool execution', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
      onProgress: () => {
        throw new Error('callback error');
      },
    };
    state.pendingDispatches.set('dispatch-8', pending);

    // Should not throw
    handleToolProgress(state, { dispatchId: 'dispatch-8', progress: 1, total: 5 });

    expect(pending.lastProgressTs).toBeDefined();
    expect(state.pendingDispatches.has('dispatch-8')).toBe(true);
    clearTimeout(pending.timerId);
  });

  test('progress without onProgress callback still updates lastProgressTs and resets timer', () => {
    const state = createState();
    const pending: PendingDispatch = {
      resolve: () => {},
      reject: () => {},
      label: 'test/tool',
      startTs: Date.now(),
      timerId: setTimeout(() => {}, DISPATCH_TIMEOUT_MS),
    };
    state.pendingDispatches.set('dispatch-9', pending);

    handleToolProgress(state, { dispatchId: 'dispatch-9', progress: 1, total: 5 });

    expect(pending.lastProgressTs).toBeDefined();
    expect(state.pendingDispatches.has('dispatch-9')).toBe(true);
    clearTimeout(pending.timerId);
  });
});

describe('rejectAllPendingConfirmations', () => {
  test('rejects all pending confirmations and clears the map', () => {
    const state = createState();
    const pending1 = createPendingConfirmation();
    const pending2 = createPendingConfirmation();
    const pending3 = createPendingConfirmation();
    state.pendingConfirmations.set('conf-a', pending1);
    state.pendingConfirmations.set('conf-b', pending2);
    state.pendingConfirmations.set('conf-c', pending3);

    rejectAllPendingConfirmations(state);

    expect(state.pendingConfirmations.size).toBe(0);
    expect(pending1.rejected).toBeInstanceOf(Error);
    expect((pending1.rejected as Error).message).toContain('Extension disconnected');
    expect(pending2.rejected).toBeInstanceOf(Error);
    expect((pending2.rejected as Error).message).toContain('Extension disconnected');
    expect(pending3.rejected).toBeInstanceOf(Error);
    expect((pending3.rejected as Error).message).toContain('Extension disconnected');
  });

  test('handles empty pendingConfirmations gracefully', () => {
    const state = createState();
    rejectAllPendingConfirmations(state);
    expect(state.pendingConfirmations.size).toBe(0);
  });
});

describe('handlePluginLog', () => {
  afterEach(() => {
    clearAllLogs();
  });

  test('valid entry is forwarded to onPluginLog callback', () => {
    let receivedEntry: unknown;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: entry => {
        receivedEntry = entry;
      },
    };

    handlePluginLog({ plugin: 'slack', level: 'info', message: 'Connected', ts: '2026-02-24T00:00:00Z' }, callbacks);

    expect(receivedEntry).toBeDefined();
    const entry = receivedEntry as { plugin: string; level: string; message: string; ts: string };
    expect(entry.plugin).toBe('slack');
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('Connected');
    expect(entry.ts).toBe('2026-02-24T00:00:00Z');
  });

  test('valid entry is appended to the log buffer', () => {
    handlePluginLog({ plugin: 'test-plugin', level: 'debug', message: 'Debug log' }, noopCallbacks);

    const logs = getLogs('test-plugin');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe('Debug log');
    expect(logs[0]?.level).toBe('debug');
  });

  test('all valid log levels are accepted', () => {
    const levels = ['debug', 'info', 'warning', 'error'];
    let callCount = 0;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        callCount++;
      },
    };

    for (const level of levels) {
      handlePluginLog({ plugin: 'test', level, message: `${level} msg` }, callbacks);
    }

    expect(callCount).toBe(4);
  });

  test('missing params is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog(undefined, callbacks);

    expect(called).toBe(false);
  });

  test('invalid level is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog({ plugin: 'test', level: 'trace', message: 'msg' }, callbacks);

    expect(called).toBe(false);
  });

  test('empty plugin name is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog({ plugin: '', level: 'info', message: 'msg' }, callbacks);

    expect(called).toBe(false);
  });

  test('non-string plugin is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog({ plugin: 123, level: 'info', message: 'msg' }, callbacks);

    expect(called).toBe(false);
  });

  test('non-string message is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog({ plugin: 'test', level: 'info', message: 42 }, callbacks);

    expect(called).toBe(false);
  });

  test('non-string level is silently dropped', () => {
    let called = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: () => {
        called = true;
      },
    };

    handlePluginLog({ plugin: 'test', level: 123, message: 'msg' }, callbacks);

    expect(called).toBe(false);
  });

  test('missing ts uses auto-generated ISO timestamp', () => {
    let receivedEntry: unknown;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: entry => {
        receivedEntry = entry;
      },
    };

    handlePluginLog({ plugin: 'test', level: 'info', message: 'no ts' }, callbacks);

    expect(receivedEntry).toBeDefined();
    const entry = receivedEntry as { ts: string };
    expect(entry.ts).toBeDefined();
    // Verify it's a valid ISO timestamp
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  test('data field is forwarded when present', () => {
    let receivedEntry: unknown;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onPluginLog: entry => {
        receivedEntry = entry;
      },
    };

    handlePluginLog({ plugin: 'test', level: 'info', message: 'with data', data: { key: 'value' } }, callbacks);

    expect(receivedEntry).toBeDefined();
    const entry = receivedEntry as { data: unknown };
    expect(entry.data).toEqual({ key: 'value' });
  });
});

describe('handleConfigGetState', () => {
  /** Create a mock WsHandle that captures sent JSON messages */
  const createMockWs = (): { ws: { send: (msg: string) => void; close: () => void }; messages: string[] } => {
    const messages: string[] = [];
    return { ws: { send: msg => messages.push(msg), close: () => {} }, messages };
  };

  test('includes browserTools in the result', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    state.cachedBrowserTools = [
      { name: 'browser_list_tabs', description: 'List all open browser tabs', inputSchema: {}, tool: null as never },
      { name: 'browser_screenshot', description: 'Capture a screenshot', inputSchema: {}, tool: null as never },
    ];

    handleConfigGetState(state, 'req-1');

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as {
      result: { browserTools: { name: string; description: string; permission: string }[] };
    };
    expect(response.result.browserTools).toHaveLength(2);
    expect(response.result.browserTools[0]).toEqual({
      name: 'browser_list_tabs',
      description: 'List all open browser tabs',
      permission: 'off',
    });
    expect(response.result.browserTools[1]).toEqual({
      name: 'browser_screenshot',
      description: 'Capture a screenshot',
      permission: 'off',
    });
  });

  test('browser tools are sorted alphabetically by name', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    state.cachedBrowserTools = [
      { name: 'browser_screenshot', description: 'Screenshot', inputSchema: {}, tool: null as never },
      { name: 'browser_click', description: 'Click', inputSchema: {}, tool: null as never },
      { name: 'browser_list_tabs', description: 'List tabs', inputSchema: {}, tool: null as never },
    ];

    handleConfigGetState(state, 'req-2');

    const response = JSON.parse(messages[0] as string) as {
      result: { browserTools: { name: string }[] };
    };
    expect(response.result.browserTools.map(t => t.name)).toEqual([
      'browser_click',
      'browser_list_tabs',
      'browser_screenshot',
    ]);
  });

  test('browser tool disabled in browserToolPolicy has permission: off', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    state.cachedBrowserTools = [
      { name: 'browser_list_tabs', description: 'List tabs', inputSchema: {}, tool: null as never },
      { name: 'browser_screenshot', description: 'Screenshot', inputSchema: {}, tool: null as never },
    ];
    state.pluginPermissions = { browser: { tools: { browser_list_tabs: 'off' } } };

    handleConfigGetState(state, 'req-3');

    const response = JSON.parse(messages[0] as string) as {
      result: { browserTools: { name: string; permission: string }[] };
    };
    const listTabs = response.result.browserTools.find(t => t.name === 'browser_list_tabs');
    const screenshot = response.result.browserTools.find(t => t.name === 'browser_screenshot');
    expect(listTabs?.permission).toBe('off');
    expect(screenshot?.permission).toBe('off');
  });

  test('empty cachedBrowserTools returns empty browserTools array', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigGetState(state, 'req-4');

    const response = JSON.parse(messages[0] as string) as {
      result: { browserTools: unknown[] };
    };
    expect(response.result.browserTools).toEqual([]);
  });

  test('includes serverVersion in the result', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigGetState(state, 'req-5');

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as {
      result: { serverVersion: unknown };
    };
    expect(typeof response.result.serverVersion).toBe('string');
    expect(response.result.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('handleConfigSetToolPermission', () => {
  const createMockWs = (): { ws: { send: (msg: string) => void; close: () => void }; messages: string[] } => {
    const messages: string[] = [];
    return { ws: { send: msg => messages.push(msg), close: () => {} }, messages };
  };

  const makePlugin = (name: string, toolNames: string[] = ['do_thing']): RegisteredPlugin => ({
    name,
    version: '1.0.0',
    displayName: name,
    urlPatterns: ['https://example.com/*'],
    iife: '',
    tools: toolNames.map(toolName => ({
      name: toolName,
      displayName: toolName,
      description: `Tool ${toolName}`,
      icon: 'activity',
      input_schema: {},
      output_schema: {},
    })),
    source: 'local',
  });

  test('sets plugin tool permission and returns { ok: true }', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['do_thing']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };

    handleConfigSetToolPermission(
      state,
      { plugin: 'test-plugin', tool: 'do_thing', permission: 'off' },
      'req-1',
      noopCallbacks,
    );

    expect(state.pluginPermissions['test-plugin']?.tools?.do_thing).toBe('off');
    expect(messages).toHaveLength(2);
    const notification = JSON.parse(messages[0] as string) as {
      method: string;
      params: { plugins: unknown[]; failedPlugins: unknown[]; browserTools: unknown[]; serverVersion: string };
    };
    expect(notification.method).toBe('plugins.changed');
    expect(Array.isArray(notification.params.plugins)).toBe(true);
    expect(Array.isArray(notification.params.failedPlugins)).toBe(true);
    expect(Array.isArray(notification.params.browserTools)).toBe(true);
    expect(typeof notification.params.serverVersion).toBe('string');
    const pluginEntry = notification.params.plugins.find(
      (p: unknown) => (p as { name: string }).name === 'test-plugin',
    ) as { tools: { name: string; permission: string }[] } | undefined;
    const tool = pluginEntry?.tools.find(t => t.name === 'do_thing');
    expect(tool?.permission).toBe('off');
    const response = JSON.parse(messages[1] as string) as { result: { ok: boolean }; id: string };
    expect(response.result).toEqual({ ok: true });
    expect(response.id).toBe('req-1');
  });

  test('sets browser tool permission with plugin=browser', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    state.cachedBrowserTools = [
      { name: 'browser_list_tabs', description: 'List tabs', inputSchema: {}, tool: null as never },
    ];

    handleConfigSetToolPermission(
      state,
      { plugin: 'browser', tool: 'browser_list_tabs', permission: 'auto' },
      'req-2',
      noopCallbacks,
    );

    expect(state.pluginPermissions.browser?.tools?.browser_list_tabs).toBe('auto');
    expect(messages).toHaveLength(2);
    const response = JSON.parse(messages[1] as string) as { result: { ok: boolean } };
    expect(response.result).toEqual({ ok: true });
  });

  test('calls onToolConfigChanged and onPluginPermissionsPersist', () => {
    const state = createState();
    const { ws } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['do_thing']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };
    let configChanged = false;
    let permissionsPersisted = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onToolConfigChanged: () => {
        configChanged = true;
      },
      onPluginPermissionsPersist: () => {
        permissionsPersisted = true;
      },
    };

    handleConfigSetToolPermission(
      state,
      { plugin: 'test-plugin', tool: 'do_thing', permission: 'ask' },
      'req-3',
      callbacks,
    );

    expect(configChanged).toBe(true);
    expect(permissionsPersisted).toBe(true);
  });

  test('unknown plugin returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetToolPermission(
      state,
      { plugin: 'nonexistent', tool: 'do_thing', permission: 'off' },
      'req-4',
      noopCallbacks,
    );

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Plugin not found');
  });

  test('unknown tool returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['do_thing']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };

    handleConfigSetToolPermission(
      state,
      { plugin: 'test-plugin', tool: 'nonexistent', permission: 'off' },
      'req-5',
      noopCallbacks,
    );

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Tool not found');
  });

  test('unknown browser tool returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    state.cachedBrowserTools = [
      { name: 'browser_list_tabs', description: 'List tabs', inputSchema: {}, tool: null as never },
    ];

    handleConfigSetToolPermission(
      state,
      { plugin: 'browser', tool: 'nonexistent_tool', permission: 'off' },
      'req-6',
      noopCallbacks,
    );

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Browser tool not found');
  });

  test('invalid permission value returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['do_thing']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };

    handleConfigSetToolPermission(
      state,
      { plugin: 'test-plugin', tool: 'do_thing', permission: 'invalid' },
      'req-7',
      noopCallbacks,
    );

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Invalid permission');
  });

  test('missing params returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetToolPermission(state, undefined, 'req-8', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toBe('Missing params');
  });

  test('invalid param types return error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetToolPermission(state, { plugin: 123, tool: 'do_thing', permission: 'yes' }, 'req-9', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('expected plugin (string)');
  });
});

describe('handleConfigSetPluginPermission', () => {
  const createMockWs = (): { ws: { send: (msg: string) => void; close: () => void }; messages: string[] } => {
    const messages: string[] = [];
    return { ws: { send: msg => messages.push(msg), close: () => {} }, messages };
  };

  const makePlugin = (name: string, toolNames: string[] = ['tool_a', 'tool_b']): RegisteredPlugin => ({
    name,
    version: '1.0.0',
    displayName: name,
    urlPatterns: ['https://example.com/*'],
    iife: '',
    tools: toolNames.map(toolName => ({
      name: toolName,
      displayName: toolName,
      description: `Tool ${toolName}`,
      icon: 'activity',
      input_schema: {},
      output_schema: {},
    })),
    source: 'local',
  });

  test('sets plugin-level permission and sends plugins.changed', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['tool_a', 'tool_b']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };

    handleConfigSetPluginPermission(state, { plugin: 'test-plugin', permission: 'auto' }, 'req-1', noopCallbacks);

    expect(state.pluginPermissions['test-plugin']?.permission).toBe('auto');
    expect(messages).toHaveLength(2);
    const notification = JSON.parse(messages[0] as string) as {
      method: string;
      params: { plugins: unknown[]; failedPlugins: unknown[]; browserTools: unknown[]; serverVersion: string };
    };
    expect(notification.method).toBe('plugins.changed');
    expect(Array.isArray(notification.params.plugins)).toBe(true);
    const response = JSON.parse(messages[1] as string) as { result: { ok: boolean }; id: string };
    expect(response.result).toEqual({ ok: true });
    expect(response.id).toBe('req-1');
  });

  test('sets browser plugin-level permission with plugin=browser', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetPluginPermission(state, { plugin: 'browser', permission: 'off' }, 'req-2', noopCallbacks);

    expect(state.pluginPermissions.browser?.permission).toBe('off');
    expect(messages).toHaveLength(2);
    const response = JSON.parse(messages[1] as string) as { result: { ok: boolean } };
    expect(response.result).toEqual({ ok: true });
  });

  test('calls onToolConfigChanged and onPluginPermissionsPersist', () => {
    const state = createState();
    const { ws } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin', ['tool_a']);
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };
    let configChanged = false;
    let permissionsPersisted = false;
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      onToolConfigChanged: () => {
        configChanged = true;
      },
      onPluginPermissionsPersist: () => {
        permissionsPersisted = true;
      },
    };

    handleConfigSetPluginPermission(state, { plugin: 'test-plugin', permission: 'ask' }, 'req-3', callbacks);

    expect(configChanged).toBe(true);
    expect(permissionsPersisted).toBe(true);
  });

  test('unknown plugin returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetPluginPermission(state, { plugin: 'nonexistent', permission: 'off' }, 'req-4', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Plugin not found');
  });

  test('invalid permission value returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const plugin = makePlugin('test-plugin');
    state.registry = {
      ...state.registry,
      plugins: new Map([['test-plugin', plugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };

    handleConfigSetPluginPermission(state, { plugin: 'test-plugin', permission: 'invalid' }, 'req-5', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('Invalid permission');
  });

  test('missing params returns error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetPluginPermission(state, undefined, 'req-6', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toBe('Missing params');
  });

  test('invalid param types return error', () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;

    handleConfigSetPluginPermission(state, { plugin: 123, permission: 'yes' }, 'req-7', noopCallbacks);

    expect(messages).toHaveLength(1);
    const response = JSON.parse(messages[0] as string) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('expected plugin (string)');
  });
});

describe('handleTabSyncAll — activeNetworkCaptures cleanup', () => {
  test('removes stale activeNetworkCaptures entries for tabs absent from sync', () => {
    const state = createState();
    // Tab 1 and 2 had active captures before the sync
    state.activeNetworkCaptures.add(1);
    state.activeNetworkCaptures.add(2);
    state.activeNetworkCaptures.add(3);

    // Sync arrives: only tab 2 is still present
    handleTabSyncAll(state, {
      tabs: {
        slack: { state: 'ready', tabs: [{ tabId: 2, url: 'https://app.slack.com', ready: true }] },
      },
    });

    expect(state.activeNetworkCaptures.has(1)).toBe(false);
    expect(state.activeNetworkCaptures.has(2)).toBe(true);
    expect(state.activeNetworkCaptures.has(3)).toBe(false);
  });

  test('clears all activeNetworkCaptures when sync has no tabs', () => {
    const state = createState();
    state.activeNetworkCaptures.add(10);
    state.activeNetworkCaptures.add(20);

    handleTabSyncAll(state, { tabs: {} });

    expect(state.activeNetworkCaptures.size).toBe(0);
  });

  test('retains activeNetworkCaptures entries for tabs still present after sync', () => {
    const state = createState();
    state.activeNetworkCaptures.add(5);

    handleTabSyncAll(state, {
      tabs: {
        slack: { state: 'ready', tabs: [{ tabId: 5, url: 'https://app.slack.com', ready: true }] },
      },
    });

    expect(state.activeNetworkCaptures.has(5)).toBe(true);
  });
});

describe('handleTabStateChanged — activeNetworkCaptures cleanup', () => {
  /** Set up a minimal registry with a given plugin name */
  const withPlugin = (state: ReturnType<typeof createState>, pluginName: string) => {
    state.registry = {
      ...state.registry,
      plugins: new Map([[pluginName, {} as RegisteredPlugin]]) as ReadonlyMap<string, RegisteredPlugin>,
    };
  };

  test('removes activeNetworkCaptures entry when a tab is removed from the plugin mapping', () => {
    const state = createState();
    withPlugin(state, 'slack');
    // Plugin currently has tabs 10 and 11, both with active captures
    state.tabMapping.set('slack', {
      state: 'ready',
      tabs: [
        { tabId: 10, url: 'https://app.slack.com', title: 'Slack', ready: true },
        { tabId: 11, url: 'https://app.slack.com', title: 'Slack', ready: true },
      ],
    });
    state.activeNetworkCaptures.add(10);
    state.activeNetworkCaptures.add(11);

    // State change arrives: only tab 10 remains
    handleTabStateChanged(state, {
      plugin: 'slack',
      state: 'ready',
      tabs: [{ tabId: 10, url: 'https://app.slack.com', title: 'Slack', ready: true }],
    });

    expect(state.activeNetworkCaptures.has(10)).toBe(true);
    expect(state.activeNetworkCaptures.has(11)).toBe(false);
  });

  test('removes all plugin tab activeNetworkCaptures entries when state changes to closed', () => {
    const state = createState();
    withPlugin(state, 'slack');
    state.tabMapping.set('slack', {
      state: 'ready',
      tabs: [{ tabId: 42, url: 'https://app.slack.com', title: 'Slack', ready: true }],
    });
    state.activeNetworkCaptures.add(42);

    handleTabStateChanged(state, { plugin: 'slack', state: 'closed', tabs: [] });

    expect(state.activeNetworkCaptures.has(42)).toBe(false);
  });

  test('does not touch activeNetworkCaptures for tabs that remain in the mapping', () => {
    const state = createState();
    withPlugin(state, 'slack');
    state.tabMapping.set('slack', {
      state: 'ready',
      tabs: [{ tabId: 7, url: 'https://app.slack.com', title: 'Slack', ready: true }],
    });
    state.activeNetworkCaptures.add(7);

    // Same tab 7 still present
    handleTabStateChanged(state, {
      plugin: 'slack',
      state: 'ready',
      tabs: [{ tabId: 7, url: 'https://app.slack.com', title: 'Slack', ready: true }],
    });

    expect(state.activeNetworkCaptures.has(7)).toBe(true);
  });
});

describe('handlePluginRemove', () => {
  /** Create a mock WsHandle that captures sent JSON messages */
  const createMockWs = (): { ws: { send: (msg: string) => void; close: () => void }; messages: string[] } => {
    const messages: string[] = [];
    return { ws: { send: msg => messages.push(msg), close: () => {} }, messages };
  };

  test('sends plugin.uninstall as a request via queryExtension, not as a notification', async () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const mockQueryExtension = vi.fn().mockResolvedValue({ success: true });
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      queryExtension: mockQueryExtension,
    };

    await handlePluginRemove(state, { name: 'test-plugin' }, 'req-1', callbacks);

    // queryExtension must be called with plugin.uninstall, the plugin name, and 5s timeout
    expect(mockQueryExtension).toHaveBeenCalledTimes(1);
    expect(mockQueryExtension).toHaveBeenCalledWith('plugin.uninstall', { name: 'test-plugin' }, 5000);

    // The direct sendToExtension call should NOT contain a plugin.uninstall notification
    const sentMessages = messages.map(m => JSON.parse(m) as Record<string, unknown>);
    const uninstallNotification = sentMessages.find(m => m.method === 'plugin.uninstall' && m.id === undefined);
    expect(uninstallNotification).toBeUndefined();
  });

  test('proceeds with plugins.changed and response even if queryExtension times out', async () => {
    const state = createState();
    const { ws, messages } = createMockWs();
    state.extensionWs = ws;
    const mockQueryExtension = vi.fn().mockRejectedValue(new Error('Timeout'));
    const callbacks: McpCallbacks = {
      ...noopCallbacks,
      queryExtension: mockQueryExtension,
    };

    await handlePluginRemove(state, { name: 'test-plugin' }, 'req-2', callbacks);

    // Despite timeout, plugins.changed and the success response must still be sent
    const sentMessages = messages.map(m => JSON.parse(m) as Record<string, unknown>);
    const pluginsChanged = sentMessages.find(m => m.method === 'plugins.changed');
    expect(pluginsChanged).toBeDefined();

    const successResponse = sentMessages.find(m => m.id === 'req-2' && m.result !== undefined);
    expect(successResponse).toBeDefined();
  });
});
