import {
  extractShortName,
  fetchConfigState,
  handleServerResponse,
  installPlugin,
  matchesPlugin,
  matchesTool,
  rejectAllPending,
  removePlugin,
  searchPlugins,
  setAllToolsEnabled,
  setToolEnabled,
  updatePlugin,
} from './bridge.js';
import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import type { PluginState, WireToolDef } from './bridge.js';

/** Captured sendMessage calls. Each entry has the message object passed to sendMessage. */
let sendMessageCalls: Array<{ message: unknown }> = [];

/**
 * When set, chrome.runtime.sendMessage will reject with this error on the next call.
 * Cleared after each call.
 */
let nextSendError: { message: string } | null = null;

beforeEach(() => {
  sendMessageCalls = [];
  nextSendError = null;

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: (message: unknown) => {
        sendMessageCalls.push({ message });

        if (nextSendError) {
          const err = new Error(nextSendError.message);
          nextSendError = null;
          return Promise.reject(err);
        }

        return Promise.resolve();
      },
    },
  };
});

/** Extract the JSON-RPC id from the most recent sendMessage call */
const getLastRequestId = (): string => {
  const last = sendMessageCalls.at(-1);
  if (!last) throw new Error('No sendMessage calls captured');
  const data = (last.message as { data: { id: string } }).data;
  return data.id;
};

/**
 * Reject all pending requests and suppress the unhandled rejections.
 * Used at the end of tests that create pending requests without resolving them.
 */
const cleanupPending = (...promises: Promise<unknown>[]): void => {
  rejectAllPending();
  for (const p of promises) {
    p.catch(() => {});
  }
};

/** Assert that a promise rejects with an error containing the given message */
const expectRejection = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(message);
  }
};

describe('handleServerResponse', () => {
  test('returns true and resolves promise for matching response id', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    const payload = { plugins: ['stub-plugin'], failedPlugins: [] };
    const handled = handleServerResponse({ id, result: payload });

    expect(handled).toBe(true);
    const result = (await promise) as unknown as Record<string, unknown>;
    expect(result.plugins).toEqual(payload.plugins);
  });

  test('returns false for messages with a method field (notifications)', () => {
    const handled = handleServerResponse({ method: 'plugins.changed', params: {} });
    expect(handled).toBe(false);
  });

  test('returns false for messages with both id and method (request-shaped)', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    const handled = handleServerResponse({ id, method: 'some.method', result: {} });
    expect(handled).toBe(false);

    handleServerResponse({ id, result: { plugins: [], failedPlugins: [] } });
    await promise;
  });

  test('returns false for unknown ids', () => {
    const handled = handleServerResponse({ id: 'nonexistent-id', result: {} });
    expect(handled).toBe(false);
  });

  test('returns false for undefined id', () => {
    const handled = handleServerResponse({ result: {} });
    expect(handled).toBe(false);
  });

  test('returns false for null id', () => {
    const handled = handleServerResponse({ id: null, result: {} });
    expect(handled).toBe(false);
  });

  test('handles numeric id by converting to string', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    // Pending map keys are string UUIDs, so a numeric id won't match
    const handled = handleServerResponse({ id: 42, result: {} });
    expect(handled).toBe(false);

    handleServerResponse({ id, result: { plugins: [], failedPlugins: [] } });
    await promise;
  });

  test('rejects promise for server error responses', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    handleServerResponse({ id, error: { message: 'Plugin not found' } });

    await expectRejection(promise, 'Plugin not found');
  });

  test('rejects with generic message for error without message field', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    handleServerResponse({ id, error: {} });

    await expectRejection(promise, 'Unknown server error');
  });

  test('resolves multiple concurrent requests independently', async () => {
    const p1 = setToolEnabled('slack', 'send-message', true);
    const id1 = getLastRequestId();

    const p2 = setToolEnabled('slack', 'list-channels', false);
    const id2 = getLastRequestId();

    // Resolve in reverse order
    handleServerResponse({ id: id2, result: { ok: true, tool: 'list-channels' } });
    handleServerResponse({ id: id1, result: { ok: true, tool: 'send-message' } });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({ ok: true, tool: 'send-message' });
    expect(r2).toEqual({ ok: true, tool: 'list-channels' });
  });
});

describe('rejectAllPending', () => {
  test('rejects all inflight requests with Server disconnected', async () => {
    const p1 = fetchConfigState();
    const p2 = setToolEnabled('slack', 'send-message', true);

    rejectAllPending();

    await expectRejection(p1, 'Server disconnected');
    await expectRejection(p2, 'Server disconnected');
  });

  test('clears pending request timers (no timeout after reject)', async () => {
    const promise = fetchConfigState();
    rejectAllPending();

    await expectRejection(promise, 'Server disconnected');

    // After rejectAllPending, handleServerResponse with the same id returns false
    // (the entry was removed from the map)
    const id = getLastRequestId();
    const handled = handleServerResponse({ id, result: {} });
    expect(handled).toBe(false);
  });

  test('is a no-op when no requests are pending', () => {
    rejectAllPending();
  });
});

describe('sendRequest error handling', () => {
  test('rejects when sendMessage rejects', async () => {
    nextSendError = { message: 'Extension context invalidated.' };

    const promise = fetchConfigState();

    await expectRejection(promise, 'Extension context invalidated.');
  });

  test('sends correct JSON-RPC message format', () => {
    const promise = setToolEnabled('slack', 'send-message', true);

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };

    expect(msg.type).toBe('bg:send');
    expect(msg.data.jsonrpc).toBe('2.0');
    expect(msg.data.method).toBe('config.setToolEnabled');
    expect(msg.data.params).toEqual({ plugin: 'slack', tool: 'send-message', enabled: true });
    expect(typeof msg.data.id).toBe('string');

    cleanupPending(promise);
  });
});

describe('setAllToolsEnabled', () => {
  test('sends JSON-RPC with method config.setAllToolsEnabled and correct params', () => {
    const promise = setAllToolsEnabled('slack', true);

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };

    expect(msg.type).toBe('bg:send');
    expect(msg.data.jsonrpc).toBe('2.0');
    expect(msg.data.method).toBe('config.setAllToolsEnabled');
    expect(msg.data.params).toEqual({ plugin: 'slack', enabled: true });
    expect(typeof msg.data.id).toBe('string');

    cleanupPending(promise);
  });

  test('sends enabled=false when disabling all tools', () => {
    const promise = setAllToolsEnabled('datadog', false);

    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };

    expect(msg.data.method).toBe('config.setAllToolsEnabled');
    expect(msg.data.params).toEqual({ plugin: 'datadog', enabled: false });

    cleanupPending(promise);
  });
});

describe('request timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('rejects after REQUEST_TIMEOUT_MS with timeout error', async () => {
    const promise = fetchConfigState();

    vi.advanceTimersByTime(30_000);

    await expectRejection(promise, 'timed out after 30000ms');
  });

  test('cleans up pending request from internal map after timeout', async () => {
    const promise = fetchConfigState();
    const id = getLastRequestId();

    vi.advanceTimersByTime(30_000);

    await expectRejection(promise, 'timed out after 30000ms');

    // After timeout, handleServerResponse with the same id returns false
    // (the entry was removed from the pending map)
    const handled = handleServerResponse({ id, result: {} });
    expect(handled).toBe(false);
  });
});

describe('getConnectionState', () => {
  test('resolves true when background reports connected', async () => {
    (chrome.runtime as Record<string, unknown>).sendMessage = (
      message: unknown,
      callback: (response: unknown) => void,
    ) => {
      sendMessageCalls.push({ message });
      (chrome.runtime as Record<string, unknown>).lastError = undefined;
      callback({ connected: true });
    };

    const { getConnectionState } = await import('./bridge.js');
    const result = await getConnectionState();
    expect(result).toEqual({ connected: true, disconnectReason: undefined });
  });

  test('resolves disconnected when background reports disconnected', async () => {
    (chrome.runtime as Record<string, unknown>).sendMessage = (
      message: unknown,
      callback: (response: unknown) => void,
    ) => {
      sendMessageCalls.push({ message });
      (chrome.runtime as Record<string, unknown>).lastError = undefined;
      callback({ connected: false, disconnectReason: 'connection_refused' });
    };

    const { getConnectionState } = await import('./bridge.js');
    const result = await getConnectionState();
    expect(result).toEqual({ connected: false, disconnectReason: 'connection_refused' });
  });

  test('resolves disconnected when chrome.runtime.lastError is set', async () => {
    (chrome.runtime as Record<string, unknown>).sendMessage = (
      message: unknown,
      callback: (response: unknown) => void,
    ) => {
      sendMessageCalls.push({ message });
      (chrome.runtime as Record<string, unknown>).lastError = { message: 'error' };
      callback(undefined);
    };

    const { getConnectionState } = await import('./bridge.js');
    const result = await getConnectionState();
    expect(result).toEqual({ connected: false, disconnectReason: undefined });
  });
});

// --- Helper to create a minimal PluginState for testing ---

const tool = (overrides?: Partial<WireToolDef>): WireToolDef => ({
  name: 'send_message',
  displayName: 'Send Message',
  description: 'Send a message to a Slack channel',
  icon: 'send',
  enabled: true,
  ...overrides,
});

const plugin = (overrides?: Partial<PluginState>): PluginState => ({
  name: 'slack',
  displayName: 'Slack',
  version: '0.1.0',
  trustTier: 'community',
  source: 'npm',
  tabState: 'ready',
  urlPatterns: ['*://*.slack.com/*'],
  sdkVersion: '0.0.3',
  tools: [tool()],
  ...overrides,
});

// --- matchesTool ---

describe('matchesTool', () => {
  test('matches on tool displayName', () => {
    expect(matchesTool(tool(), 'send message')).toBe(true);
    expect(matchesTool(tool(), 'send')).toBe(true);
  });

  test('filterLower param must be lowercase (contract)', () => {
    // matchesTool lowercases the tool fields but compares against filterLower as-is.
    // Callers must pass a lowercase string.
    expect(matchesTool(tool(), 'send')).toBe(true);
    expect(matchesTool(tool(), 'SEND')).toBe(false);
  });

  test('matches on tool name (case-insensitive)', () => {
    expect(matchesTool(tool(), 'send_message')).toBe(true);
    expect(matchesTool(tool(), 'send_m')).toBe(true);
  });

  test('matches on tool description', () => {
    expect(matchesTool(tool(), 'slack channel')).toBe(true);
  });

  test('does not match unrelated query', () => {
    expect(matchesTool(tool(), 'github')).toBe(false);
  });

  test('matches partial substring', () => {
    expect(matchesTool(tool(), 'end_mes')).toBe(true);
  });

  test('empty filter matches everything', () => {
    expect(matchesTool(tool(), '')).toBe(true);
  });
});

// --- matchesPlugin ---

describe('matchesPlugin', () => {
  test('matches on plugin displayName', () => {
    expect(matchesPlugin(plugin(), 'slack')).toBe(true);
    expect(matchesPlugin(plugin(), 'sla')).toBe(true);
  });

  test('filterLower param must be lowercase (contract)', () => {
    expect(matchesPlugin(plugin(), 'slack')).toBe(true);
    expect(matchesPlugin(plugin(), 'SLACK')).toBe(false);
  });

  test('matches on plugin name', () => {
    expect(matchesPlugin(plugin(), 'slack')).toBe(true);
  });

  test('matches on tool name', () => {
    expect(matchesPlugin(plugin(), 'send_message')).toBe(true);
  });

  test('matches on tool displayName', () => {
    expect(matchesPlugin(plugin(), 'send message')).toBe(true);
  });

  test('does NOT match on tool description', () => {
    // The tool description says "Send a message to a Slack channel"
    // but matchesPlugin should not match on description text alone
    const p = plugin({
      name: 'e2e-test',
      displayName: 'E2E Test',
      tools: [tool({ name: 'do_thing', displayName: 'Do Thing', description: 'Does something with Slack' })],
    });
    expect(matchesPlugin(p, 'slack')).toBe(false);
  });

  test('does not match unrelated query', () => {
    expect(matchesPlugin(plugin(), 'github')).toBe(false);
  });

  test('matches when any tool name matches', () => {
    const p = plugin({
      tools: [
        tool({ name: 'list_channels', displayName: 'List Channels' }),
        tool({ name: 'send_message', displayName: 'Send Message' }),
      ],
    });
    expect(matchesPlugin(p, 'list_channels')).toBe(true);
  });

  test('empty filter matches everything', () => {
    expect(matchesPlugin(plugin(), '')).toBe(true);
  });

  test('plugin with no tools only matches on name/displayName', () => {
    const p = plugin({ tools: [] });
    expect(matchesPlugin(p, 'slack')).toBe(true);
    expect(matchesPlugin(p, 'send')).toBe(false);
  });
});

// --- extractShortName ---

describe('extractShortName', () => {
  test('extracts short name from scoped npm package', () => {
    expect(extractShortName('@opentabs-dev/opentabs-plugin-slack')).toBe('slack');
  });

  test('extracts short name from unscoped npm package', () => {
    expect(extractShortName('opentabs-plugin-datadog')).toBe('datadog');
  });

  test('returns bare name unchanged', () => {
    expect(extractShortName('slack')).toBe('slack');
  });

  test('handles scoped package without opentabs-plugin prefix', () => {
    expect(extractShortName('@org/my-tool')).toBe('my-tool');
  });

  test('handles empty string', () => {
    expect(extractShortName('')).toBe('');
  });

  test('handles deeply nested scope', () => {
    expect(extractShortName('@a/b/opentabs-plugin-x')).toBe('x');
  });

  test('only strips the opentabs-plugin- prefix, not other prefixes', () => {
    expect(extractShortName('my-plugin-slack')).toBe('my-plugin-slack');
  });
});

// --- plugin management bridge functions ---

describe('searchPlugins', () => {
  test('sends JSON-RPC with method plugin.search and correct params', () => {
    const promise = searchPlugins('slack');

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };
    expect(msg.type).toBe('bg:send');
    expect(msg.data.method).toBe('plugin.search');
    expect(msg.data.params).toEqual({ query: 'slack' });

    cleanupPending(promise);
  });

  test('resolves with search results from server', async () => {
    const promise = searchPlugins('slack');
    const id = getLastRequestId();

    const payload = {
      results: [{ name: 'slack', description: 'Slack', version: '1.0', author: 'x', isOfficial: true }],
    };
    handleServerResponse({ id, result: payload });

    const result = await promise;
    expect(result).toEqual(payload);
  });
});

describe('installPlugin', () => {
  test('sends JSON-RPC with method plugin.install and correct params', () => {
    const promise = installPlugin('@opentabs-dev/opentabs-plugin-slack');

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };
    expect(msg.data.method).toBe('plugin.install');
    expect(msg.data.params).toEqual({ name: '@opentabs-dev/opentabs-plugin-slack' });

    cleanupPending(promise);
  });

  test('resolves with install result from server', async () => {
    const promise = installPlugin('slack');
    const id = getLastRequestId();

    const payload = { ok: true, plugin: { name: 'slack', displayName: 'Slack', version: '1.0', toolCount: 3 } };
    handleServerResponse({ id, result: payload });

    const result = await promise;
    expect(result).toEqual(payload);
  });

  test('rejects with server error on install failure', async () => {
    const promise = installPlugin('nonexistent');
    const id = getLastRequestId();

    handleServerResponse({ id, error: { message: 'Package not found in registry' } });

    await expectRejection(promise, 'Package not found in registry');
  });
});

describe('removePlugin', () => {
  test('sends JSON-RPC with method plugin.remove and correct params', () => {
    const promise = removePlugin('slack');

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };
    expect(msg.data.method).toBe('plugin.remove');
    expect(msg.data.params).toEqual({ name: 'slack' });

    cleanupPending(promise);
  });

  test('resolves with ok result from server', async () => {
    const promise = removePlugin('slack');
    const id = getLastRequestId();

    handleServerResponse({ id, result: { ok: true } });

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  test('rejects when plugin is not installed', async () => {
    const promise = removePlugin('nonexistent');
    const id = getLastRequestId();

    handleServerResponse({ id, error: { message: 'Plugin not installed' } });

    await expectRejection(promise, 'Plugin not installed');
  });
});

describe('updatePlugin', () => {
  test('sends JSON-RPC with method plugin.updateFromRegistry and correct params', () => {
    const promise = updatePlugin('slack');

    expect(sendMessageCalls).toHaveLength(1);
    const entry = sendMessageCalls.at(0);
    if (!entry) throw new Error('Expected sendMessage call');
    const msg = entry.message as { type: string; data: Record<string, unknown> };
    expect(msg.data.method).toBe('plugin.updateFromRegistry');
    expect(msg.data.params).toEqual({ name: 'slack' });

    cleanupPending(promise);
  });

  test('resolves with update result from server', async () => {
    const promise = updatePlugin('slack');
    const id = getLastRequestId();

    const payload = { ok: true, plugin: { name: 'slack', displayName: 'Slack', version: '2.0', toolCount: 5 } };
    handleServerResponse({ id, result: payload });

    const result = await promise;
    expect(result).toEqual(payload);
  });
});
