import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DispatchResult } from './dispatch-helpers.js';
import type { PluginMeta } from './extension-messages.js';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing dispatch-helpers.ts so that
// the exported functions bind to the mocked versions of dependencies.
// ---------------------------------------------------------------------------

const {
  mockSendToServer,
  mockGetPluginMeta,
  mockFindAllMatchingTabs,
  mockUrlMatchesPatterns,
  mockSanitizeErrorDetails,
} = vi.hoisted(() => ({
  mockSendToServer: vi.fn<(data: unknown) => void>(),
  mockGetPluginMeta: vi.fn<(name: string) => Promise<PluginMeta | null>>(),
  mockFindAllMatchingTabs: vi.fn<(plugin: PluginMeta) => Promise<chrome.tabs.Tab[]>>(),
  mockUrlMatchesPatterns: vi.fn<(url: string, patterns: string[]) => boolean>(),
  mockSanitizeErrorDetails: vi.fn<(details: unknown) => Record<string, unknown> | undefined>(
    details => details as Record<string, unknown>,
  ),
}));

vi.mock('./messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: vi.fn(),
}));

vi.mock('./plugin-storage.js', () => ({
  storePluginsBatch: vi.fn(),
  removePlugin: vi.fn(),
  removePluginsBatch: vi.fn(),
  getAllPluginMeta: vi.fn(),
  getPluginMeta: mockGetPluginMeta,
  invalidatePluginCache: vi.fn(),
}));

vi.mock('./tab-matching.js', () => ({
  findAllMatchingTabs: mockFindAllMatchingTabs,
  urlMatchesPatterns: mockUrlMatchesPatterns,
  matchPattern: vi.fn(),
  findMatchingTab: vi.fn(),
}));

vi.mock('./sanitize-error.js', () => ({
  sanitizeErrorMessage: (msg: string) => msg,
  sanitizeErrorDetails: mockSanitizeErrorDetails,
}));

// Chrome API stubs
const mockTabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();
(globalThis as Record<string, unknown>).chrome = {
  tabs: { get: mockTabsGet },
};

// Import after mocking
const { resolvePlugin, isAdapterNotReady, dispatchWithTabFallback, dispatchToTargetedTab } = await import(
  './dispatch-helpers.js'
);

/** Helper to build a minimal PluginMeta for tests */
const makePlugin = (overrides?: Partial<PluginMeta>): PluginMeta => ({
  name: 'test-plugin',
  version: '1.0.0',
  displayName: 'Test Plugin',
  urlPatterns: ['*://example.com/*'],
  permission: 'off',
  tools: [],
  ...overrides,
});

/** Safely extract the first argument from the first call to mockSendToServer */
const firstSentMessage = (): Record<string, unknown> => {
  const calls = mockSendToServer.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// resolvePlugin
// ---------------------------------------------------------------------------

describe('resolvePlugin', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockGetPluginMeta.mockReset();
  });

  test('returns plugin metadata when found', async () => {
    const plugin = makePlugin();
    mockGetPluginMeta.mockResolvedValue(plugin);

    const result = await resolvePlugin('test-plugin', 'req-10');
    expect(result).toBe(plugin);
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32603 error when plugin not found', async () => {
    mockGetPluginMeta.mockResolvedValue(null);

    const result = await resolvePlugin('nonexistent', 'req-11');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-11',
      error: { code: -32603 },
    });
  });

  test('error message includes the plugin name', async () => {
    mockGetPluginMeta.mockResolvedValue(null);

    await resolvePlugin('missing-plugin', 'req-12');
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('missing-plugin');
  });
});

// ---------------------------------------------------------------------------
// isAdapterNotReady
// ---------------------------------------------------------------------------

describe('isAdapterNotReady', () => {
  test('returns true for error result with code -32002', () => {
    expect(isAdapterNotReady({ type: 'error', code: -32002, message: 'Not ready' })).toBe(true);
  });

  test('returns false for success result', () => {
    expect(isAdapterNotReady({ type: 'success', output: 'ok' })).toBe(false);
  });

  test('returns false for error result with different code', () => {
    expect(isAdapterNotReady({ type: 'error', code: -32603, message: 'Other error' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchWithTabFallback
// ---------------------------------------------------------------------------

describe('dispatchWithTabFallback', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockFindAllMatchingTabs.mockReset();
    mockUrlMatchesPatterns.mockReset();
    mockTabsGet.mockReset();
  });

  const plugin = makePlugin();

  test('sends -32001 error when no matching tabs', async () => {
    mockFindAllMatchingTabs.mockResolvedValue([]);

    await dispatchWithTabFallback({
      id: 'req-20',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab: vi.fn(),
    });

    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-20',
      error: { code: -32001 },
    });
  });

  test('calls executeOnTab for matching tab and sends success result', async () => {
    const tab = { id: 1, url: 'https://example.com/page' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab]);
    mockTabsGet.mockResolvedValue(tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'success', output: { data: 'result' } });

    await dispatchWithTabFallback({
      id: 'req-21',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(executeOnTab).toHaveBeenCalledWith(1);
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-21',
      result: { output: { data: 'result' } },
    });
  });

  test('falls back to next tab on adapter-not-ready error', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);
    mockTabsGet.mockImplementation(tabId =>
      Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
    );
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockImplementation(tabId => {
      if (tabId === 1) return Promise.resolve({ type: 'error', code: -32002, message: 'Adapter not ready' });
      return Promise.resolve({ type: 'success', output: 'ok' });
    });

    await dispatchWithTabFallback({
      id: 'req-22',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(2);
    expect(executeOnTab).toHaveBeenCalledWith(1);
    expect(executeOnTab).toHaveBeenCalledWith(2);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-22',
      result: { output: 'ok' },
    });
  });

  test('falls back to next tab on tab-gone error', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);
    mockTabsGet.mockImplementation(tabId =>
      Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
    );
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockImplementation(tabId => {
      if (tabId === 1) return Promise.reject(new Error('No tab with id: 1'));
      return Promise.resolve({ type: 'success', output: 'recovered' });
    });

    await dispatchWithTabFallback({
      id: 'req-23',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(2);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-23',
      result: { output: 'recovered' },
    });
  });

  test('sends first error when all tabs fail', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);
    mockTabsGet.mockImplementation(tabId =>
      Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
    );
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'error', code: -32002, message: 'Adapter not ready' });

    await dispatchWithTabFallback({
      id: 'req-24',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-24',
      error: { code: -32002, message: 'Adapter not ready' },
    });
  });

  test('sends -32001 for tabs with undefined IDs', async () => {
    const tab = { url: 'https://example.com/page' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab]);

    await dispatchWithTabFallback({
      id: 'req-25',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab: vi.fn(),
    });

    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-25',
      error: { code: -32001 },
    });
  });

  test('skips tab when TOCTOU recheck shows URL no longer matches', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);

    mockTabsGet.mockImplementation(tabId => {
      if (tabId === 1) return Promise.resolve({ id: 1, url: 'https://other.com/page' } as chrome.tabs.Tab);
      return Promise.resolve({ id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab);
    });
    mockUrlMatchesPatterns.mockImplementation(url => new URL(url).hostname === 'example.com');

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'success', output: 'ok' });

    await dispatchWithTabFallback({
      id: 'req-26',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(executeOnTab).toHaveBeenCalledWith(2);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-26',
      result: { output: 'ok' },
    });
  });

  test('skips tab when chrome.tabs.get throws (tab closed during TOCTOU)', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);

    mockTabsGet.mockImplementation(tabId => {
      if (tabId === 1) return Promise.reject(new Error('No tab with id: 1'));
      return Promise.resolve({ id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab);
    });
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'success', output: 'ok' });

    await dispatchWithTabFallback({
      id: 'req-27',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(executeOnTab).toHaveBeenCalledWith(2);
  });

  test('sends non-adapter error immediately without fallback', async () => {
    const tab1 = { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab;
    const tab2 = { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab;
    mockFindAllMatchingTabs.mockResolvedValue([tab1, tab2]);
    mockTabsGet.mockImplementation(tabId =>
      Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
    );
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'error', code: -32603, message: 'Internal error' });

    await dispatchWithTabFallback({
      id: 'req-28',
      pluginName: 'test-plugin',
      plugin,
      operationName: 'tool dispatch',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-28',
      error: { code: -32603, message: 'Internal error' },
    });
  });

  describe('tab id echo', () => {
    const twoTabs = () => {
      mockFindAllMatchingTabs.mockResolvedValue([
        { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab,
        { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab,
      ]);
      mockTabsGet.mockImplementation(tabId =>
        Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
      );
      mockUrlMatchesPatterns.mockReturnValue(true);
    };

    test('success echoes the tab the tool ran in beside the output', async () => {
      twoTabs();
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockImplementation(tabId => {
        if (tabId === 1) return Promise.resolve({ type: 'error', code: -32002, message: 'Adapter not ready' });
        return Promise.resolve({ type: 'success', output: { ok: true } });
      });

      await dispatchWithTabFallback({
        id: 'req-40',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'x',
        executeOnTab,
      });

      expect(firstSentMessage()).toEqual({ jsonrpc: '2.0', id: 'req-40', result: { output: { ok: true }, tabId: 2 } });
    });

    test('a structured error carries its data plus the tab id', async () => {
      twoTabs();
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockResolvedValue({
        type: 'error',
        code: -32603,
        message: 'Upstream failed',
        data: { code: 'UPSTREAM_UNAVAILABLE', category: 'internal', retryable: true, details: { httpStatus: 503 } },
      });

      await dispatchWithTabFallback({
        id: 'req-41',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'x',
        executeOnTab,
      });

      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-41',
        error: {
          code: -32603,
          message: 'Upstream failed',
          data: {
            code: 'UPSTREAM_UNAVAILABLE',
            category: 'internal',
            retryable: true,
            details: { httpStatus: 503 },
            tabId: 1,
          },
        },
      });
      expect(mockSanitizeErrorDetails).toHaveBeenCalledWith({ httpStatus: 503 });
    });

    test('a thrown non-tab-gone failure carries the tab id', async () => {
      twoTabs();
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockRejectedValue(new Error('Unexpected script error'));

      await dispatchWithTabFallback({
        id: 'req-42',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'x',
        executeOnTab,
      });

      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-42',
        error: { code: -32603, message: 'Script execution failed: Unexpected script error', data: { tabId: 1 } },
      });
    });

    test('when every tab is not ready, the first error names the tab that produced it', async () => {
      twoTabs();
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockResolvedValue({
        type: 'error',
        code: -32002,
        message: 'Adapter not ready',
        data: { code: 'NOT_READY', category: 'auth' },
      });

      await dispatchWithTabFallback({
        id: 'req-43',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'x',
        executeOnTab,
      });

      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-43',
        error: { code: -32002, message: 'Adapter not ready', data: { code: 'NOT_READY', category: 'auth', tabId: 1 } },
      });
    });

    test('a tab that disappears while the tool runs is reported as closed during the operation', async () => {
      mockFindAllMatchingTabs.mockResolvedValue([{ id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab]);
      mockTabsGet.mockResolvedValue({ id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab);
      mockUrlMatchesPatterns.mockReturnValue(true);
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockRejectedValue(new Error('No tab with id: 1'));

      await dispatchWithTabFallback({
        id: 'req-45',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'tool dispatch',
        executeOnTab,
      });

      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-45',
        error: { code: -32001, message: 'Tab closed during tool dispatch', data: { tabId: 1 } },
      });
    });

    test('when every tab disappears while its tool runs, the first error names the first tab', async () => {
      twoTabs();
      const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
      executeOnTab.mockImplementation(tabId => Promise.reject(new Error(`No tab with id: ${tabId}`)));

      await dispatchWithTabFallback({
        id: 'req-46',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'tool dispatch',
        executeOnTab,
      });

      expect(executeOnTab).toHaveBeenCalledTimes(2);
      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-46',
        error: { code: -32001, message: 'Tab closed during tool dispatch', data: { tabId: 1 } },
      });
    });

    test('a pre-execution rejection on every tab carries no tab id', async () => {
      mockFindAllMatchingTabs.mockResolvedValue([{ id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab]);
      mockTabsGet.mockRejectedValue(new Error('No tab with id: 1'));

      await dispatchWithTabFallback({
        id: 'req-44',
        pluginName: 'test-plugin',
        plugin,
        operationName: 'tool dispatch',
        executeOnTab: vi.fn(),
      });

      expect(firstSentMessage()).toEqual({
        jsonrpc: '2.0',
        id: 'req-44',
        error: { code: -32001, message: 'Tab closed before tool dispatch', data: undefined },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// dispatchToTargetedTab
// ---------------------------------------------------------------------------

describe('dispatchToTargetedTab', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockUrlMatchesPatterns.mockReset();
    mockTabsGet.mockReset();
    mockSanitizeErrorDetails.mockClear();
    mockSanitizeErrorDetails.mockImplementation(details => details as Record<string, unknown>);
  });

  const plugin = makePlugin();

  test('dispatches to targeted tab when tab exists and URL matches, echoing the tab id', async () => {
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'success', output: { data: 'targeted' } });

    await dispatchToTargetedTab({
      id: 'req-30',
      pluginName: 'test-plugin',
      plugin,
      tabId: 42,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(executeOnTab).toHaveBeenCalledWith(42);
    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-30',
      result: { output: { data: 'targeted' }, tabId: 42 },
    });
  });

  test('echoes the tab id even when the output is undefined', async () => {
    mockTabsGet.mockResolvedValue({ id: 43, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'success', output: undefined });

    await dispatchToTargetedTab({
      id: 'req-30b',
      pluginName: 'test-plugin',
      plugin,
      tabId: 43,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toEqual({ jsonrpc: '2.0', id: 'req-30b', result: { output: undefined, tabId: 43 } });
  });

  test('sends -32001 error when tab does not exist', async () => {
    mockTabsGet.mockRejectedValue(new Error('No tab with id: 999'));

    await dispatchToTargetedTab({
      id: 'req-31',
      pluginName: 'test-plugin',
      plugin,
      tabId: 999,
      operationName: 'tool execution',
      executeOnTab: vi.fn(),
    });

    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-31',
      error: { code: -32001 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('999');
    expect(msg.error.message).toContain('does not exist');
  });

  test('sends -32003 error when tab URL does not match plugin patterns', async () => {
    mockTabsGet.mockResolvedValue({ id: 50, url: 'https://banking.com/account' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(false);

    await dispatchToTargetedTab({
      id: 'req-32',
      pluginName: 'test-plugin',
      plugin,
      tabId: 50,
      operationName: 'tool execution',
      executeOnTab: vi.fn(),
    });

    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-32',
      error: { code: -32003 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('does not match');
    expect(msg.error.message).toContain('test-plugin');
  });

  test('sends -32003 error when tab has no URL', async () => {
    mockTabsGet.mockResolvedValue({ id: 51 } as chrome.tabs.Tab);

    await dispatchToTargetedTab({
      id: 'req-32b',
      pluginName: 'test-plugin',
      plugin,
      tabId: 51,
      operationName: 'tool execution',
      executeOnTab: vi.fn(),
    });

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-32b',
      error: { code: -32003 },
    });
  });

  test('sends adapter-not-ready error without fallback', async () => {
    mockTabsGet.mockResolvedValue({ id: 60, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'error', code: -32002, message: 'Adapter not ready' });

    await dispatchToTargetedTab({
      id: 'req-33',
      pluginName: 'test-plugin',
      plugin,
      tabId: 60,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(executeOnTab).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-33',
      error: { code: -32002, message: 'Adapter not ready' },
    });
  });

  test('sends -32001 error when tab closes during execution', async () => {
    mockTabsGet.mockResolvedValue({ id: 70, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockRejectedValue(new Error('No tab with id: 70'));

    await dispatchToTargetedTab({
      id: 'req-34',
      pluginName: 'test-plugin',
      plugin,
      tabId: 70,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-34',
      error: { code: -32001 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('Tab closed');
  });

  test('sends -32603 error on non-tab-gone execution failure', async () => {
    mockTabsGet.mockResolvedValue({ id: 80, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockRejectedValue(new Error('Unexpected script error'));

    await dispatchToTargetedTab({
      id: 'req-35',
      pluginName: 'test-plugin',
      plugin,
      tabId: 80,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-35',
      error: { code: -32603 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('Script execution failed');
  });

  test('forwards error data from dispatch result', async () => {
    mockTabsGet.mockResolvedValue({ id: 90, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({
      type: 'error',
      code: -32603,
      message: 'Tool failed',
      data: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000 },
    });

    await dispatchToTargetedTab({
      id: 'req-36',
      pluginName: 'test-plugin',
      plugin,
      tabId: 90,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-36',
      error: {
        code: -32603,
        message: 'Tool failed',
        data: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000, tabId: 90 },
      },
    });
    expect(mockSanitizeErrorDetails).not.toHaveBeenCalled();
  });

  test('a legacy error without data still carries the tab id', async () => {
    mockTabsGet.mockResolvedValue({ id: 91, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({ type: 'error', code: -32603, message: 'Tool failed' });

    await dispatchToTargetedTab({
      id: 'req-37',
      pluginName: 'test-plugin',
      plugin,
      tabId: 91,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-37',
      error: { code: -32603, message: 'Tool failed', data: { tabId: 91 } },
    });
  });

  test('a tab-gone failure during execution carries the tab id', async () => {
    mockTabsGet.mockResolvedValue({ id: 92, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockRejectedValue(new Error('No tab with id: 92'));

    await dispatchToTargetedTab({
      id: 'req-38',
      pluginName: 'test-plugin',
      plugin,
      tabId: 92,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-38',
      error: { code: -32001, message: 'Tab closed during tool execution', data: { tabId: 92 } },
    });
  });

  test('forwards sanitized error details from the dispatch result', async () => {
    mockTabsGet.mockResolvedValue({ id: 93, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);
    mockSanitizeErrorDetails.mockReturnValue({ httpStatus: 500, endpoint: '[URL]' });

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({
      type: 'error',
      code: -32603,
      message: 'Upstream failed',
      data: {
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        details: { httpStatus: 500, endpoint: 'https://outlook.office.com/api/v2.0/me/messages/AAMk' },
      },
    });

    await dispatchToTargetedTab({
      id: 'req-39',
      pluginName: 'test-plugin',
      plugin,
      tabId: 93,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(mockSanitizeErrorDetails).toHaveBeenCalledWith({
      httpStatus: 500,
      endpoint: 'https://outlook.office.com/api/v2.0/me/messages/AAMk',
    });
    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-39',
      error: {
        code: -32603,
        message: 'Upstream failed',
        data: {
          code: 'UPSTREAM_UNAVAILABLE',
          retryable: true,
          details: { httpStatus: 500, endpoint: '[URL]' },
          tabId: 93,
        },
      },
    });
  });

  test('omits details the sanitizer rejects while keeping the other fields', async () => {
    mockTabsGet.mockResolvedValue({ id: 94, url: 'https://example.com/page' } as chrome.tabs.Tab);
    mockUrlMatchesPatterns.mockReturnValue(true);
    mockSanitizeErrorDetails.mockReturnValue(undefined);

    const executeOnTab = vi.fn<(tabId: number) => Promise<DispatchResult>>();
    executeOnTab.mockResolvedValue({
      type: 'error',
      code: -32603,
      message: 'Rate limited',
      data: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000, details: { huge: 'x' } },
    });

    await dispatchToTargetedTab({
      id: 'req-39b',
      pluginName: 'test-plugin',
      plugin,
      tabId: 94,
      operationName: 'tool execution',
      executeOnTab,
    });

    expect(firstSentMessage()).toEqual({
      jsonrpc: '2.0',
      id: 'req-39b',
      error: {
        code: -32603,
        message: 'Rate limited',
        data: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000, tabId: 94 },
      },
    });
  });
});
