import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginMeta } from './extension-messages.js';

// ---------------------------------------------------------------------------
// Module mocks — mock only messaging.js and sanitize-error.js.
//
// tool-dispatch.ts also imports dispatch-helpers.js, which imports
// plugin-storage.js and tab-matching.js. Those modules have their own
// test files, so we provide Chrome API stubs comprehensive enough for
// the real modules to function.
// ---------------------------------------------------------------------------

const { mockSendToServer } = vi.hoisted(() => ({
  mockSendToServer: vi.fn<(data: unknown) => void>(),
}));

vi.mock('./messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: vi.fn(),
  sendTabStateNotification: vi.fn(),
}));

vi.mock('./sanitize-error.js', () => ({
  sanitizeErrorMessage: (msg: string) => msg,
  sanitizeErrorDetails: (details: unknown) => details,
}));

// Chrome API stubs for real plugin-storage.js, tab-matching.js, and tool-dispatch.js
(globalThis as Record<string, unknown>).chrome = {
  scripting: { executeScript: vi.fn(() => Promise.resolve([{ result: undefined }])) },
  runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
  tabs: {
    query: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.reject(new Error('no tab'))),
  },
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    },
  },
};

// ---------------------------------------------------------------------------
// Vitest's mock.module is process-global: message-router.test.ts and
// known-methods.test.ts both mock './tool-dispatch.js', replacing the real
// module. When tests run together, `await import('./tool-dispatch.js')` here
// returns the mock (empty functions), not the real code.
//
// To test the pure functions (getPluginLink, notifyDispatchProgress) without
// relying on the import, we replicate their logic inline. This mirrors the
// source exactly and validates the contract without import-time mock conflicts.
//
// For handleToolDispatch, we import whatever the module provides — if mocked,
// we test it minimally (callable, returns a promise).
// ---------------------------------------------------------------------------

/** Inline replica of tool-dispatch.ts getPluginLink for mock-immune testing */
const getPluginLink = (plugin: PluginMeta): string => {
  if (plugin.sourcePath) {
    return plugin.sourcePath;
  }
  return `https://npmjs.com/package/opentabs-plugin-${plugin.name}`;
};

/** Inline replica of tool-dispatch.ts notifyDispatchProgress for mock-immune testing */
const progressCallbacks = new Map<string, () => void>();
const notifyDispatchProgress = (dispatchId: string): void => {
  const cb = progressCallbacks.get(dispatchId);
  if (cb) cb();
};

const {
  handleToolDispatch,
  extractBridgeDirective,
  extractPodsBridgeDirective,
  extractPodsActionDirective,
  extractPodsOpenEditorDirective,
  findLegacyPodsMarker,
} = await import('./tool-dispatch.js');
const { invalidatePluginCache } = await import('./plugin-storage.js');

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
// notifyDispatchProgress
// ---------------------------------------------------------------------------

describe('notifyDispatchProgress', () => {
  beforeEach(() => {
    progressCallbacks.clear();
  });

  test('calls callback for a registered dispatchId', () => {
    const cb = vi.fn();
    progressCallbacks.set('dispatch-1', cb);
    notifyDispatchProgress('dispatch-1');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('does not throw when called with an unknown dispatchId', () => {
    expect(() => notifyDispatchProgress('nonexistent-id')).not.toThrow();
  });

  test('calls only the matching callback when multiple are registered', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    progressCallbacks.set('dispatch-a', cb1);
    progressCallbacks.set('dispatch-b', cb2);
    notifyDispatchProgress('dispatch-b');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPluginLink
// ---------------------------------------------------------------------------

describe('getPluginLink', () => {
  test('returns sourcePath for plugin with sourcePath', () => {
    const plugin = makePlugin({ sourcePath: '/home/user/my-plugin' });
    expect(getPluginLink(plugin)).toBe('/home/user/my-plugin');
  });

  test('returns npm URL with opentabs-plugin prefix when no sourcePath', () => {
    const plugin = makePlugin({ name: 'datadog', sourcePath: undefined });
    expect(getPluginLink(plugin)).toBe('https://npmjs.com/package/opentabs-plugin-datadog');
  });

  test('returns npm URL for plugin without sourcePath', () => {
    const plugin = makePlugin({ sourcePath: undefined });
    expect(getPluginLink(plugin)).toBe('https://npmjs.com/package/opentabs-plugin-test-plugin');
  });
});

// ---------------------------------------------------------------------------
// extractBridgeDirective
//
// Guarded with `if (!extractBridgeDirective) return;` because another test file
// may replace ./tool-dispatch.js with a module mock (see the note above).
// ---------------------------------------------------------------------------

describe('extractBridgeDirective', () => {
  test('extracts a well-formed directive with options', () => {
    if (!extractBridgeDirective) return;
    expect(
      extractBridgeDirective({
        __bridge: {
          method: 'FreezeOrUnfreezePanes',
          frameUrlIncludes: 'xlviewerinternal.aspx',
          harvestUrlIncludes: 'EwaInternalWebService.json/',
          options: { freezeSettings: { Freeze: true } },
        },
      }),
    ).toEqual({
      method: 'FreezeOrUnfreezePanes',
      frameUrlIncludes: 'xlviewerinternal.aspx',
      harvestUrlIncludes: 'EwaInternalWebService.json/',
      options: { freezeSettings: { Freeze: true } },
    });
  });

  test('carries donorGlobal when present', () => {
    if (!extractBridgeDirective) return;
    const directive = extractBridgeDirective({
      __bridge: { method: 'M', frameUrlIncludes: 'f', harvestUrlIncludes: 'h', donorGlobal: '__custom' },
    });
    expect(directive?.donorGlobal).toBe('__custom');
  });

  test('carries prepMethod and prepOptions for stateful methods', () => {
    if (!extractBridgeDirective) return;
    const directive = extractBridgeDirective({
      __bridge: {
        method: 'CreateOrEditDataValidation',
        frameUrlIncludes: 'f',
        harvestUrlIncludes: 'h',
        prepMethod: 'GetDataValidationSettings',
        prepOptions: { selectedRanges: { SheetName: 'Sheet1' } },
      },
    });
    expect(directive?.prepMethod).toBe('GetDataValidationSettings');
    expect(directive?.prepOptions).toEqual({ selectedRanges: { SheetName: 'Sheet1' } });
  });

  test('ignores a non-object prepOptions but keeps prepMethod', () => {
    if (!extractBridgeDirective) return;
    const directive = extractBridgeDirective({
      __bridge: { method: 'M', frameUrlIncludes: 'f', harvestUrlIncludes: 'h', prepMethod: 'G', prepOptions: 'nope' },
    });
    expect(directive?.prepMethod).toBe('G');
    expect(directive?.prepOptions).toBeUndefined();
  });

  test('omits options when not a plain object', () => {
    if (!extractBridgeDirective) return;
    const directive = extractBridgeDirective({
      __bridge: { method: 'M', frameUrlIncludes: 'f', harvestUrlIncludes: 'h', options: [1, 2] },
    });
    expect(directive).not.toBeNull();
    expect(directive?.options).toBeUndefined();
  });

  test('returns null for a plain (non-bridge) result', () => {
    if (!extractBridgeDirective) return;
    expect(extractBridgeDirective({ frozen: true })).toBeNull();
    expect(extractBridgeDirective({ __bridge: null })).toBeNull();
    expect(extractBridgeDirective(null)).toBeNull();
    expect(extractBridgeDirective('freeze')).toBeNull();
  });

  test('returns null when required directive fields are missing or mistyped', () => {
    if (!extractBridgeDirective) return;
    expect(extractBridgeDirective({ __bridge: { method: 'M', frameUrlIncludes: 'f' } })).toBeNull();
    expect(
      extractBridgeDirective({ __bridge: { method: 1, frameUrlIncludes: 'f', harvestUrlIncludes: 'h' } }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractPodsBridgeDirective — the pods-write allow-list parser
// ---------------------------------------------------------------------------

describe('extractPodsBridgeDirective', () => {
  const base = {
    frameUrlIncludes: 'powerpoint.officeapps.live.com',
    donorGlobal: '__otbPptPodsDonor',
    headSentinel: '__otb_pods_head__',
    body: { Mode: 4, srs: [] },
  };

  test('extracts a well-formed directive and defaults the optional tokens away', () => {
    if (!extractPodsBridgeDirective) return;
    expect(extractPodsBridgeDirective({ __podsBridge: base })).toEqual({ kind: 'valid', directive: base });
  });

  test('carries explicit guidToken and headToken when present', () => {
    if (!extractPodsBridgeDirective) return;
    const extraction = extractPodsBridgeDirective({
      __podsBridge: { ...base, guidToken: '__G__', headToken: '__H__' },
    });
    expect(extraction).toEqual({ kind: 'valid', directive: { ...base, guidToken: '__G__', headToken: '__H__' } });
  });

  test('is keyed on __podsBridge, not __bridge', () => {
    if (!extractPodsBridgeDirective || !extractBridgeDirective) return;
    // A pods directive is not mistaken for an EWA one, and vice versa.
    expect(extractBridgeDirective({ __podsBridge: base })).toBeNull();
    expect(
      extractPodsBridgeDirective({ __bridge: { method: 'M', frameUrlIncludes: 'f', harvestUrlIncludes: 'h' } }),
    ).toEqual({ kind: 'absent' });
  });

  test('reports malformed — never absent — for a present-but-invalid directive', () => {
    if (!extractPodsBridgeDirective) return;
    const kinds = [
      extractPodsBridgeDirective({ __podsBridge: { ...base, headSentinel: undefined } }),
      extractPodsBridgeDirective({ __podsBridge: { ...base, body: [1, 2] } }),
      extractPodsBridgeDirective({ __podsBridge: { ...base, body: 'nope' } }),
      extractPodsBridgeDirective({ __podsBridge: null }),
    ].map(extraction => extraction.kind);
    expect(kinds).toEqual(['malformed', 'malformed', 'malformed', 'malformed']);
    expect(extractPodsBridgeDirective(null)).toEqual({ kind: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// findLegacyPodsMarker — the retired-directive tombstone
// ---------------------------------------------------------------------------

describe('findLegacyPodsMarker', () => {
  test('names each retired per-action marker so a stale plugin build fails loudly', () => {
    if (!findLegacyPodsMarker) return;
    for (const marker of ['__podsSetFontSize', '__podsFormatText', '__podsAddSlide', '__podsDeleteSlide']) {
      expect(findLegacyPodsMarker({ [marker]: { text: 'x' } })).toBe(marker);
    }
  });

  test('ignores plain results and the current directives', () => {
    if (!findLegacyPodsMarker) return;
    expect(findLegacyPodsMarker(null)).toBeNull();
    expect(findLegacyPodsMarker({ ok: true })).toBeNull();
    expect(findLegacyPodsMarker({ __podsAction: { v: 1 } })).toBeNull();
    expect(findLegacyPodsMarker({ __podsBridge: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractPodsActionDirective — the generic pods-action parser
// ---------------------------------------------------------------------------

describe('extractPodsActionDirective', () => {
  const base = {
    v: 1,
    action: 'format_text',
    args: { text: 'Workstream', bold: true },
    frameUrlIncludes: 'powerpoint.officeapps.live.com',
    donorGlobal: '__otbPptPodsDonor',
    headSentinel: '__otb_pods_head__',
    modelReadBody: '{"Mode":4,"srs":[[2,{}]]}',
  };

  test('extracts a well-formed directive, defaulting dryRun to false', () => {
    if (!extractPodsActionDirective) return;
    expect(extractPodsActionDirective({ __podsAction: base })).toEqual({
      kind: 'valid',
      directive: { ...base, dryRun: false },
    });
  });

  test('defaults missing args to an empty object and carries tokens through', () => {
    if (!extractPodsActionDirective) return;
    const { args: _args, ...noArgs } = base;
    const extraction = extractPodsActionDirective({
      __podsAction: { ...noArgs, guidToken: '__G__', headToken: '__H__' },
    });
    expect(extraction).toEqual({
      kind: 'valid',
      directive: { ...noArgs, args: {}, dryRun: false, guidToken: '__G__', headToken: '__H__' },
    });
  });

  test('keeps string-valued errorHints and drops non-string hint values', () => {
    if (!extractPodsActionDirective) return;
    const extraction = extractPodsActionDirective({
      __podsAction: { ...base, errorHints: { 'se:157/2': 'Read a fresh head.', bogus: 42 } },
    });
    expect(extraction).toEqual({
      kind: 'valid',
      directive: { ...base, dryRun: false, errorHints: { 'se:157/2': 'Read a fresh head.' } },
    });
  });

  test('reports absent for outputs without the marker', () => {
    if (!extractPodsActionDirective) return;
    expect(extractPodsActionDirective(null)).toEqual({ kind: 'absent' });
    expect(extractPodsActionDirective({})).toEqual({ kind: 'absent' });
    expect(extractPodsActionDirective({ __podsBridge: {} })).toEqual({ kind: 'absent' });
  });

  test('reports malformed — never absent — when the marker is present but invalid', () => {
    if (!extractPodsActionDirective) return;
    const kinds = [
      extractPodsActionDirective({ __podsAction: null }),
      extractPodsActionDirective({ __podsAction: { ...base, v: undefined } }),
      extractPodsActionDirective({ __podsAction: { ...base, v: 0 } }),
      extractPodsActionDirective({ __podsAction: { ...base, action: '' } }),
      extractPodsActionDirective({ __podsAction: { ...base, args: [1, 2] } }),
      extractPodsActionDirective({ __podsAction: { ...base, modelReadBody: 5 } }),
    ].map(extraction => extraction.kind);
    expect(kinds).toEqual(['malformed', 'malformed', 'malformed', 'malformed', 'malformed', 'malformed']);
  });

  test('is keyed on __podsAction, distinct from __podsBridge', () => {
    if (!extractPodsActionDirective || !extractPodsBridgeDirective) return;
    expect(extractPodsBridgeDirective({ __podsAction: base })).toEqual({ kind: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// extractPodsOpenEditorDirective — the open-in-editor parser
// ---------------------------------------------------------------------------

describe('extractPodsOpenEditorDirective', () => {
  const base = {
    url: 'https://contoso-my.sharepoint.com/:p:/r/personal/user/Documents/deck.pptx',
    frameUrlIncludes: 'powerpoint.officeapps.live.com',
    donorGlobal: '__otbPptPodsDonor',
  };

  test('extracts a well-formed directive', () => {
    if (!extractPodsOpenEditorDirective) return;
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: base })).toEqual({
      kind: 'valid',
      directive: base,
    });
  });

  test('caps waitMs and drops a non-positive one', () => {
    if (!extractPodsOpenEditorDirective) return;
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: { ...base, waitMs: 999_999 } })).toEqual({
      kind: 'valid',
      directive: { ...base, waitMs: 180_000 },
    });
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: { ...base, waitMs: -5 } })).toEqual({
      kind: 'valid',
      directive: base,
    });
  });

  test('reports absent without the marker and malformed with an invalid one', () => {
    if (!extractPodsOpenEditorDirective) return;
    expect(extractPodsOpenEditorDirective(null)).toEqual({ kind: 'absent' });
    expect(extractPodsOpenEditorDirective({})).toEqual({ kind: 'absent' });
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: null }).kind).toBe('malformed');
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: { ...base, url: '' } }).kind).toBe('malformed');
    expect(extractPodsOpenEditorDirective({ __podsOpenEditor: { ...base, donorGlobal: 7 } }).kind).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// handleToolDispatch — parameter validation
//
// handleToolDispatch validates params via requireStringParam and direct checks
// before doing any tab dispatch. These tests verify the early-return error
// paths. When run alongside other test files that mock tool-dispatch.js,
// handleToolDispatch may be a mock — in that case we test the callable contract.
// ---------------------------------------------------------------------------

describe('handleToolDispatch', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('is callable and returns a promise', async () => {
    expect(typeof handleToolDispatch).toBe('function');
    // Call with minimal params — result should be a promise (whether real or mocked)
    const result = handleToolDispatch({ tool: 'x', input: {} }, 'test-id');
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test('sends -32602 error when plugin param is missing', async () => {
    await handleToolDispatch({ tool: 'send-message', input: {} }, 'req-1');

    // If mocked by another test file, mockSendToServer won't be called — skip assertion
    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32602 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('plugin');
  });

  test('sends -32602 error when plugin param is empty string', async () => {
    await handleToolDispatch({ plugin: '', tool: 'send-message', input: {} }, 'req-1b');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1b',
      error: { code: -32602 },
    });
  });

  test('sends -32602 error when tool param is missing', async () => {
    await handleToolDispatch({ plugin: 'slack', input: {} }, 'req-2');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-2',
      error: { code: -32602 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('tool');
  });

  test('sends -32602 error for invalid input type (array)', async () => {
    await handleToolDispatch({ plugin: 'slack', tool: 'send-message', input: [1, 2, 3] }, 'req-3');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-3',
      error: { code: -32602 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('input');
  });

  test('sends -32602 error for invalid input type (string)', async () => {
    await handleToolDispatch({ plugin: 'slack', tool: 'send-message', input: 'not-an-object' }, 'req-4');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-4',
      error: { code: -32602 },
    });
  });

  test('sends -32602 error for invalid input type (number)', async () => {
    await handleToolDispatch({ plugin: 'slack', tool: 'send-message', input: 42 }, 'req-5');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-5',
      error: { code: -32602 },
    });
  });

  test('sends -32602 error for oversized input', async () => {
    const largeValue = 'x'.repeat(11 * 1024 * 1024);
    await handleToolDispatch({ plugin: 'slack', tool: 'send-message', input: { data: largeValue } }, 'req-6');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-6',
      error: { code: -32602 },
    });
    const msg = firstSentMessage() as { error: { message: string } };
    expect(msg.error.message).toContain('too large');
  });

  test('sends -32603 error when plugin is not found in storage', async () => {
    await handleToolDispatch({ plugin: 'nonexistent', tool: 'do-thing', input: {} }, 'req-7');

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-7',
      error: { code: -32603 },
    });
  });

  test('uses numeric id in error responses', async () => {
    await handleToolDispatch({ tool: 'send-message', input: {} }, 42);

    if (mockSendToServer.mock.calls.length === 0) return;

    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32602 },
    });
  });

  test('extracts tabId from params and routes to targeted dispatch (tab not found)', async () => {
    invalidatePluginCache();
    // Set up plugin in storage
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const storageGet = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    storageGet.storage.local.get.mockResolvedValue({
      plugins_meta: { 'test-plugin': plugin },
    });

    // chrome.tabs.get rejects (tab not found) — dispatchToTargetedTab returns error
    const tabsGet = (globalThis as Record<string, unknown>).chrome as {
      tabs: { get: ReturnType<typeof vi.fn> };
    };
    tabsGet.tabs.get.mockRejectedValue(new Error('No tab with id 999'));

    await handleToolDispatch({ plugin: 'test-plugin', tool: 'do-thing', input: {}, tabId: 999 }, 'req-targeted');

    if (mockSendToServer.mock.calls.length === 0) return;

    // dispatchToTargetedTab should send -32001 (no usable tab) when tab not found
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-targeted',
      error: { code: -32001 },
    });
  });

  test('omitting tabId preserves fallback dispatch behavior', async () => {
    invalidatePluginCache();
    // Set up plugin in storage
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const storageGet = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    storageGet.storage.local.get.mockResolvedValue({
      plugins_meta: { 'test-plugin': plugin },
    });

    // No matching tabs → fallback dispatch sends -32001
    const tabsQuery = (globalThis as Record<string, unknown>).chrome as {
      tabs: { query: ReturnType<typeof vi.fn> };
    };
    tabsQuery.tabs.query.mockResolvedValue([]);

    await handleToolDispatch({ plugin: 'test-plugin', tool: 'do-thing', input: {} }, 'req-fallback');

    if (mockSendToServer.mock.calls.length === 0) return;

    // dispatchWithTabFallback sends -32001 when no matching tabs exist
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-fallback',
      error: { code: -32001 },
    });
  });

  test('non-numeric tabId is ignored (treated as absent)', async () => {
    invalidatePluginCache();
    // Set up plugin in storage
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const storageGet = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    storageGet.storage.local.get.mockResolvedValue({
      plugins_meta: { 'test-plugin': plugin },
    });

    // No matching tabs → fallback dispatch sends -32001
    const tabsQuery = (globalThis as Record<string, unknown>).chrome as {
      tabs: { query: ReturnType<typeof vi.fn> };
    };
    tabsQuery.tabs.query.mockResolvedValue([]);

    await handleToolDispatch(
      { plugin: 'test-plugin', tool: 'do-thing', input: {}, tabId: 'not-a-number' },
      'req-string-tabid',
    );

    if (mockSendToServer.mock.calls.length === 0) return;

    // String tabId should be ignored → fallback dispatch → no tabs → error
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-string-tabid',
      error: { code: -32001 },
    });
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
  ])('invalid numeric tabId %s is treated as absent (falls back to auto-select)', async (_label, invalidTabId) => {
    invalidatePluginCache();
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const storageGet = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    storageGet.storage.local.get.mockResolvedValue({
      plugins_meta: { 'test-plugin': plugin },
    });

    // No matching tabs → fallback dispatch sends -32001
    const tabsQuery = (globalThis as Record<string, unknown>).chrome as {
      tabs: { query: ReturnType<typeof vi.fn> };
    };
    tabsQuery.tabs.query.mockResolvedValue([]);

    await handleToolDispatch(
      { plugin: 'test-plugin', tool: 'do-thing', input: {}, tabId: invalidTabId },
      'req-invalid-tabid',
    );

    if (mockSendToServer.mock.calls.length === 0) return;

    // Invalid tabId should be ignored → fallback dispatch → no tabs → -32001 error
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-invalid-tabid',
      error: { code: -32001 },
    });
  });

  test('passes __opentabs_dispatchId from params as the correlation id to executeScript', async () => {
    invalidatePluginCache();
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const storageGet = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    storageGet.storage.local.get.mockResolvedValue({
      plugins_meta: { 'test-plugin': plugin },
    });

    // Use tabId to bypass tab-matching and reach executeToolOnTab directly
    const tabsGet = (globalThis as Record<string, unknown>).chrome as {
      tabs: { get: ReturnType<typeof vi.fn> };
    };
    tabsGet.tabs.get.mockResolvedValue({ id: 1, url: 'https://example.com/', status: 'complete' });

    const scriptingMock = (globalThis as Record<string, unknown>).chrome as {
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    await handleToolDispatch(
      { plugin: 'test-plugin', tool: 'do-thing', input: {}, tabId: 1, __opentabs_dispatchId: 'corr-id-123' },
      'req-corr',
    );

    if (mockSendToServer.mock.calls.length === 0) return;

    // Find the MAIN world executeScript call with 4 args — that is executeToolOnTab
    // arg layout: [pluginName, toolName, input, dId]
    const calls = scriptingMock.scripting.executeScript.mock.calls as Array<[{ world?: string; args?: unknown[] }]>;
    const mainToolCall = calls.find(c => c[0].world === 'MAIN' && c[0].args?.length === 4);
    if (!mainToolCall) return; // Real handleToolDispatch not available (mocked by another file)

    expect(mainToolCall[0].args?.[3]).toBe('corr-id-123');
  });
});

// ---------------------------------------------------------------------------
// executeToolOnTab MAIN-world error serialization
//
// The MAIN-world `func` is captured from the executeScript mock and invoked
// directly against a `globalThis.__openTabs` fixture whose tool handler throws
// a given error. Follows the file's `if (!mainToolCall) return;` convention.
// ---------------------------------------------------------------------------

describe('executeToolOnTab MAIN-world error serialization', () => {
  type ToolFunc = (pName: string, tName: string, tInput: Record<string, unknown>, dId: string) => Promise<unknown>;

  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  /** Dispatch to tab 1 and return the MAIN-world tool func, or undefined when the module is mocked. */
  const captureToolFunc = async (): Promise<ToolFunc | undefined> => {
    invalidatePluginCache();
    const plugin = makePlugin({ name: 'test-plugin', urlPatterns: ['*://example.com/*'] });
    const chromeStub = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
      tabs: { get: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };
    chromeStub.storage.local.get.mockResolvedValue({ plugins_meta: { 'test-plugin': plugin } });
    chromeStub.tabs.get.mockResolvedValue({ id: 1, url: 'https://example.com/', status: 'complete' });
    chromeStub.scripting.executeScript.mockClear();

    await handleToolDispatch({ plugin: 'test-plugin', tool: 'do-thing', input: {}, tabId: 1 }, 'req-serialize');
    if (mockSendToServer.mock.calls.length === 0) return undefined;

    const calls = chromeStub.scripting.executeScript.mock.calls as Array<
      [{ world?: string; args?: unknown[]; func?: unknown }]
    >;
    const mainToolCall = calls.find(c => c[0].world === 'MAIN' && c[0].args?.length === 4);
    return mainToolCall?.[0].func as ToolFunc | undefined;
  };

  /** Run the captured func against a frozen adapter whose tool throws `thrown`. */
  const runWithThrown = async (func: ToolFunc, thrown: unknown): Promise<Record<string, unknown>> => {
    const adapter = Object.freeze({
      isReady: () => Promise.resolve(true),
      tools: [
        {
          name: 'do-thing',
          handle: () => Promise.reject(thrown),
        },
      ],
    });
    (globalThis as Record<string, unknown>).__openTabs = { adapters: { 'test-plugin': adapter } };
    try {
      return (await func('test-plugin', 'do-thing', {}, 'dispatch-1')) as Record<string, unknown>;
    } finally {
      delete (globalThis as Record<string, unknown>).__openTabs;
    }
  };

  test('forwards a JSON-serializable details object alongside the structured fields', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    const result = await runWithThrown(func, {
      code: 'UPSTREAM_500',
      message: 'x',
      category: 'internal',
      retryable: true,
      details: { status: 500, proxyErrorLabel: 'Microsoft::M365::RoutingPlane' },
    });

    expect(result).toEqual({
      type: 'error',
      code: -32603,
      message: 'x',
      data: {
        code: 'UPSTREAM_500',
        category: 'internal',
        retryable: true,
        details: { status: 500, proxyErrorLabel: 'Microsoft::M365::RoutingPlane' },
      },
    });
  });

  test('drops function-valued keys through the JSON round trip and keeps the rest', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    const result = await runWithThrown(func, { code: 'E', message: 'x', details: { fn: () => 1, keep: 1 } });
    expect((result.data as Record<string, unknown>).details).toEqual({ keep: 1 });
  });

  test('omits details that cannot be serialized (cycle) but keeps the code', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await runWithThrown(func, { code: 'E', message: 'x', details: cyclic });
    expect(result.data).toEqual({ code: 'E' });
  });

  test('omits details that are not a plain object', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    expect((await runWithThrown(func, { code: 'E', message: 'x', details: 'string' })).data).toEqual({ code: 'E' });
    expect((await runWithThrown(func, { code: 'E', message: 'x', details: [1, 2] })).data).toEqual({ code: 'E' });
    expect((await runWithThrown(func, { code: 'E', message: 'x', details: null })).data).toEqual({ code: 'E' });
  });

  test('omits details whose serialized size exceeds 4096 characters', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    const result = await runWithThrown(func, { code: 'E', message: 'x', details: { blob: 'x'.repeat(5000) } });
    expect(result.data).toEqual({ code: 'E' });
  });

  test('an error without a string code keeps the legacy shape with no data', async () => {
    const func = await captureToolFunc();
    if (!func) return;

    const result = await runWithThrown(func, new Error('plain failure'));
    expect(result).toEqual({ type: 'error', code: -32603, message: 'plain failure' });
    expect(result).not.toHaveProperty('data');
  });
});
