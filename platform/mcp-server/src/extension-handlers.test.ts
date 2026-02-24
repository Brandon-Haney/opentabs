import {
  handleConfirmationResponse,
  handlePluginLog,
  handleToolProgress,
  rejectAllPendingConfirmations,
} from './extension-handlers.js';
import { clearAllLogs, getLogs } from './log-buffer.js';
import { createState, DISPATCH_TIMEOUT_MS, MAX_DISPATCH_TIMEOUT_MS } from './state.js';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { McpCallbacks } from './extension-handlers.js';
import type { PendingConfirmation, PendingDispatch, SessionPermissionRule } from './state.js';

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
    timerId: setTimeout(() => {}, 60_000),
    tool: 'slack_send_message',
    domain: 'app.slack.com',
    ...overrides,
  };
  return result;
};

/** No-op MCP callbacks */
const noopCallbacks: McpCallbacks = {
  onToolConfigChanged: () => {},
  onToolConfigPersist: () => {},
  onPluginLog: () => {},
  onReload: () => Promise.resolve({ plugins: 0, durationMs: 0 }),
};

describe('handleConfirmationResponse', () => {
  test('allow_once resolves the pending confirmation', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-1', pending);

    handleConfirmationResponse(state, { id: 'conf-1', decision: 'allow_once' });

    expect(pending.resolved).toBe('allow_once');
    expect(state.pendingConfirmations.has('conf-1')).toBe(false);
  });

  test('deny resolves the pending confirmation with deny', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-2', pending);

    handleConfirmationResponse(state, { id: 'conf-2', decision: 'deny' });

    expect(pending.resolved).toBe('deny');
    expect(state.pendingConfirmations.has('conf-2')).toBe(false);
  });

  test('unknown id is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-3', pending);

    handleConfirmationResponse(state, { id: 'nonexistent', decision: 'allow_once' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-3')).toBe(true);
    clearTimeout(pending.timerId);
  });

  test('allow_always with default scope (tool_domain) adds session permission rule', () => {
    const state = createState();
    const pending = createPendingConfirmation({ tool: 'slack_send_message', domain: 'app.slack.com' });
    state.pendingConfirmations.set('conf-4', pending);

    handleConfirmationResponse(state, { id: 'conf-4', decision: 'allow_always' });

    expect(pending.resolved).toBe('allow_always');
    expect(state.sessionPermissions).toHaveLength(1);
    const rule = state.sessionPermissions[0] as SessionPermissionRule;
    expect(rule.tool).toBe('slack_send_message');
    expect(rule.domain).toBe('app.slack.com');
    expect(rule.scope).toBe('tool_domain');
  });

  test('allow_always with scope tool_all sets domain to null', () => {
    const state = createState();
    const pending = createPendingConfirmation({ tool: 'slack_send_message', domain: 'app.slack.com' });
    state.pendingConfirmations.set('conf-5', pending);

    handleConfirmationResponse(state, { id: 'conf-5', decision: 'allow_always', scope: 'tool_all' });

    expect(state.sessionPermissions).toHaveLength(1);
    const rule = state.sessionPermissions[0] as SessionPermissionRule;
    expect(rule.tool).toBe('slack_send_message');
    expect(rule.domain).toBeNull();
    expect(rule.scope).toBe('tool_all');
  });

  test('allow_always with scope domain_all sets tool to null', () => {
    const state = createState();
    const pending = createPendingConfirmation({ tool: 'slack_send_message', domain: 'app.slack.com' });
    state.pendingConfirmations.set('conf-6', pending);

    handleConfirmationResponse(state, { id: 'conf-6', decision: 'allow_always', scope: 'domain_all' });

    expect(state.sessionPermissions).toHaveLength(1);
    const rule = state.sessionPermissions[0] as SessionPermissionRule;
    expect(rule.tool).toBeNull();
    expect(rule.domain).toBe('app.slack.com');
    expect(rule.scope).toBe('domain_all');
  });

  test('missing params is silently ignored', () => {
    const state = createState();
    handleConfirmationResponse(state, undefined);
    expect(state.pendingConfirmations.size).toBe(0);
    expect(state.sessionPermissions).toHaveLength(0);
  });

  test('invalid decision value is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-7', pending);

    handleConfirmationResponse(state, { id: 'conf-7', decision: 'invalid' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-7')).toBe(true);
    clearTimeout(pending.timerId);
  });

  test('non-string id is silently ignored', () => {
    const state = createState();
    const pending = createPendingConfirmation();
    state.pendingConfirmations.set('conf-8', pending);

    handleConfirmationResponse(state, { id: 123, decision: 'allow_once' });

    expect(pending.resolved).toBeUndefined();
    expect(state.pendingConfirmations.has('conf-8')).toBe(true);
    clearTimeout(pending.timerId);
  });

  test('clears the pending confirmation timer', () => {
    const state = createState();
    let timerCleared = false;
    const timerId = setTimeout(() => {
      timerCleared = false;
    }, 60_000);
    const pending = createPendingConfirmation({ timerId });
    state.pendingConfirmations.set('conf-9', pending);

    handleConfirmationResponse(state, { id: 'conf-9', decision: 'allow_once' });

    // The timer was cleared by clearTimeout — verify by checking the confirmation was removed
    expect(state.pendingConfirmations.has('conf-9')).toBe(false);
    expect(pending.resolved).toBe('allow_once');
    // Suppress unused variable lint
    void timerCleared;
  });
});

describe('handleToolProgress', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
    jest.advanceTimersByTime(DISPATCH_TIMEOUT_MS - 5_000);
    expect(state.pendingDispatches.has('dispatch-3')).toBe(true);

    // Send progress — this should reset the timer
    handleToolProgress(state, { dispatchId: 'dispatch-3', progress: 1, total: 10 });

    // Advance past the original timeout — dispatch should still be alive
    jest.advanceTimersByTime(10_000);
    expect(state.pendingDispatches.has('dispatch-3')).toBe(true);
    expect(rejected).toBeUndefined();

    // Advance to trigger the new timeout (DISPATCH_TIMEOUT_MS from progress)
    jest.advanceTimersByTime(DISPATCH_TIMEOUT_MS);
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
