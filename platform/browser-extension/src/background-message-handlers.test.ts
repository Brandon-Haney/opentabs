import { vi, describe, expect, test, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing background-message-handlers.js so
// the module's internal references bind to the mocked versions.
// ---------------------------------------------------------------------------

const {
  mockSendToServer,
  mockForwardToSidePanel,
  mockClearTabStateCache,
  mockClearAllConfirmationBadges,
  mockClearConfirmationBackgroundTimeout,
  mockClearConfirmationBadge,
  mockHandleServerMessage,
  mockNotifyDispatchProgress,
} = vi.hoisted(() => ({
  mockSendToServer: vi.fn<(data: unknown) => void>(),
  mockForwardToSidePanel: vi.fn(),
  mockClearTabStateCache: vi.fn(),
  mockClearAllConfirmationBadges: vi.fn(),
  mockClearConfirmationBackgroundTimeout: vi.fn(),
  mockClearConfirmationBadge: vi.fn(),
  mockHandleServerMessage: vi.fn(),
  mockNotifyDispatchProgress: vi.fn(),
}));

vi.mock('./messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: mockForwardToSidePanel,
}));

vi.mock('./tab-state.js', () => ({
  clearTabStateCache: mockClearTabStateCache,
}));

vi.mock('./confirmation-badge.js', () => ({
  clearAllConfirmationBadges: mockClearAllConfirmationBadges,
  clearConfirmationBackgroundTimeout: mockClearConfirmationBackgroundTimeout,
  clearConfirmationBadge: mockClearConfirmationBadge,
}));

vi.mock('./message-router.js', () => ({
  handleServerMessage: mockHandleServerMessage,
}));

vi.mock('./tool-dispatch.js', () => ({
  notifyDispatchProgress: mockNotifyDispatchProgress,
}));

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

const mockStorageSessionGet = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({});
const mockStorageSessionSet = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockStorageLocalGet = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({});
const mockRuntimeSendMessage = vi.fn(() => Promise.resolve());

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    session: {
      get: mockStorageSessionGet,
      set: mockStorageSessionSet,
    },
    local: {
      get: mockStorageLocalGet,
    },
  },
  runtime: {
    sendMessage: mockRuntimeSendMessage,
    id: 'test-extension-id',
  },
};

const {
  handleWsState,
  handlePluginLogs,
  handleToolProgress,
  handleSpConfirmationResponse,
  handleSpConfirmationTimeout,
  handleBgGetConnectionState,
} = await import('./background-message-handlers.js');

// ---------------------------------------------------------------------------
// Test setup — reset module-level wsConnected state to false before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Drive wsConnected to false by simulating a disconnect, then clear all mocks.
  // handleWsState({connected: false}) always sets wsConnected=false via persistWsConnected,
  // regardless of prior state. Side-effect calls (clearTabStateCache, etc.) are wiped
  // by vi.clearAllMocks() immediately after.
  handleWsState({ connected: false }, () => {});
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleWsState
// ---------------------------------------------------------------------------

describe('handleWsState', () => {
  test('connect: persists wsConnected=true to chrome.storage.session', () => {
    handleWsState({ connected: true }, () => {});

    expect(mockStorageSessionSet).toHaveBeenCalledWith({ wsConnected: true });
  });

  test('connect: forwards connection state to side panel', () => {
    handleWsState({ connected: true }, () => {});

    expect(mockForwardToSidePanel).toHaveBeenCalledWith({
      type: 'sp:connectionState',
      data: { connected: true, disconnectReason: undefined },
    });
  });

  test('connect: does NOT call clearTabStateCache or clearAllConfirmationBadges', () => {
    handleWsState({ connected: true }, () => {});

    expect(mockClearTabStateCache).not.toHaveBeenCalled();
    expect(mockClearAllConfirmationBadges).not.toHaveBeenCalled();
  });

  test('disconnect after connect: persists wsConnected=false to chrome.storage.session', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleWsState({ connected: false }, () => {});

    expect(mockStorageSessionSet).toHaveBeenCalledWith({ wsConnected: false });
  });

  test('disconnect after connect: calls clearTabStateCache', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleWsState({ connected: false }, () => {});

    expect(mockClearTabStateCache).toHaveBeenCalledOnce();
  });

  test('disconnect after connect: calls clearAllConfirmationBadges', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleWsState({ connected: false }, () => {});

    expect(mockClearAllConfirmationBadges).toHaveBeenCalledOnce();
  });

  test('disconnect when already disconnected: still calls clearTabStateCache', () => {
    // wsConnected is already false from beforeEach (simulates race where ws:state
    // arrives before restoreWsConnectedState completes — cleanup must always run)
    handleWsState({ connected: false }, () => {});

    expect(mockClearTabStateCache).toHaveBeenCalledOnce();
  });

  test('disconnect when already disconnected: still calls clearAllConfirmationBadges', () => {
    // wsConnected is already false from beforeEach
    handleWsState({ connected: false }, () => {});

    expect(mockClearAllConfirmationBadges).toHaveBeenCalledOnce();
  });

  test('service worker wake race: cleanup runs even when ws:state arrives before restoreWsConnectedState', () => {
    // Simulate the race condition: service worker wakes with wsConnected=false (default),
    // restoreWsConnectedState has not yet completed (storage read still pending),
    // and the offscreen document sends ws:state connected=false.
    // Old code skipped cleanup because wasConnected was false; new code always cleans up.
    handleWsState({ connected: false, disconnectReason: 'server_shutdown' }, () => {});

    expect(mockClearTabStateCache).toHaveBeenCalledOnce();
    expect(mockClearAllConfirmationBadges).toHaveBeenCalledOnce();
  });

  test('disconnect with disconnectReason: forwards reason to side panel', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleWsState({ connected: false, disconnectReason: 'auth_failure' }, () => {});

    expect(mockForwardToSidePanel).toHaveBeenCalledWith({
      type: 'sp:connectionState',
      data: { connected: false, disconnectReason: 'auth_failure' },
    });
  });

  test('sendResponse is called with { ok: true }', () => {
    const sendResponse = vi.fn();
    handleWsState({ connected: true }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handlePluginLogs
// ---------------------------------------------------------------------------

describe('handlePluginLogs', () => {
  test('does not forward logs when wsConnected is false', () => {
    handlePluginLogs(
      {
        plugin: 'my-plugin',
        entries: [{ level: 'info', message: 'hello', data: undefined, ts: 0 }],
      },
      () => {},
    );

    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('does not forward logs when entries is not an array', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handlePluginLogs({ plugin: 'my-plugin', entries: 'not-an-array' }, () => {});

    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('forwards valid log entries to server when connected', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handlePluginLogs(
      {
        plugin: 'my-plugin',
        entries: [{ level: 'info', message: 'hello', data: { x: 1 }, ts: 1234 }],
      },
      () => {},
    );

    expect(mockSendToServer).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'plugin.log',
      params: {
        plugin: 'my-plugin',
        level: 'info',
        message: 'hello',
        data: { x: 1 },
        ts: 1234,
      },
    });
  });

  test('forwards multiple valid log entries', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handlePluginLogs(
      {
        plugin: 'p',
        entries: [
          { level: 'info', message: 'a', data: null, ts: 1 },
          { level: 'error', message: 'b', data: null, ts: 2 },
        ],
      },
      () => {},
    );

    expect(mockSendToServer).toHaveBeenCalledTimes(2);
  });

  test('skips non-object entries in the array', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handlePluginLogs(
      {
        plugin: 'p',
        entries: ['not-an-object', null, { level: 'info', message: 'valid', data: null, ts: 0 }],
      },
      () => {},
    );

    // Only the valid object entry should be forwarded
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
  });

  test('sendResponse is always called with { ok: true }', () => {
    const sendResponse = vi.fn();
    handlePluginLogs({ entries: [] }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleToolProgress
// ---------------------------------------------------------------------------

describe('handleToolProgress', () => {
  test('calls notifyDispatchProgress with correct dispatchId when connected', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleToolProgress({ dispatchId: 'dispatch-abc', progress: 1, total: 10 }, () => {});

    expect(mockNotifyDispatchProgress).toHaveBeenCalledWith('dispatch-abc');
  });

  test('calls notifyDispatchProgress even when wsConnected is false', () => {
    // wsConnected is false from beforeEach
    handleToolProgress({ dispatchId: 'dispatch-xyz', progress: 0, total: 5 }, () => {});

    expect(mockNotifyDispatchProgress).toHaveBeenCalledWith('dispatch-xyz');
  });

  test('does NOT call notifyDispatchProgress when dispatchId is not a string', () => {
    handleToolProgress({ dispatchId: 42, progress: 0, total: 5 }, () => {});

    expect(mockNotifyDispatchProgress).not.toHaveBeenCalled();
  });

  test('sends tool.progress to server when connected and all params are valid', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleToolProgress({ dispatchId: 'abc', progress: 3, total: 10 }, () => {});

    expect(mockSendToServer).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'tool.progress',
      params: { dispatchId: 'abc', progress: 3, total: 10, message: undefined },
    });
  });

  test('includes optional message in tool.progress params', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleToolProgress({ dispatchId: 'abc', progress: 5, total: 10, message: 'Processing...' }, () => {});

    expect(mockSendToServer).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'tool.progress',
      params: { dispatchId: 'abc', progress: 5, total: 10, message: 'Processing...' },
    });
  });

  test('does NOT send to server when wsConnected is false', () => {
    handleToolProgress({ dispatchId: 'abc', progress: 3, total: 10 }, () => {});

    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('does NOT send to server when progress is not a number', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleToolProgress({ dispatchId: 'abc', progress: 'bad', total: 10 }, () => {});

    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('sendResponse is always called with { ok: true }', () => {
    const sendResponse = vi.fn();
    handleToolProgress({}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleSpConfirmationResponse
// ---------------------------------------------------------------------------

describe('handleSpConfirmationResponse', () => {
  test('sends confirmation.response to server when connected', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    const data = { id: 'conf-1', approved: true };
    handleSpConfirmationResponse({ data }, () => {});

    expect(mockSendToServer).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'confirmation.response',
      params: data,
    });
  });

  test('does NOT send to server when wsConnected is false', () => {
    handleSpConfirmationResponse({ data: { id: 'conf-1', approved: true } }, () => {});

    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('clears background timeout when data.id is a string', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    handleSpConfirmationResponse({ data: { id: 'conf-42' } }, () => {});

    expect(mockClearConfirmationBackgroundTimeout).toHaveBeenCalledWith('conf-42');
  });

  test('does NOT call clearConfirmationBackgroundTimeout when data.id is not a string', () => {
    handleSpConfirmationResponse({ data: { id: 99 } }, () => {});

    expect(mockClearConfirmationBackgroundTimeout).not.toHaveBeenCalled();
  });

  test('always calls clearConfirmationBadge', () => {
    handleSpConfirmationResponse({ data: {} }, () => {});

    expect(mockClearConfirmationBadge).toHaveBeenCalledOnce();
  });

  test('sendResponse is always called with { ok: true }', () => {
    const sendResponse = vi.fn();
    handleSpConfirmationResponse({ data: {} }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleSpConfirmationTimeout
// ---------------------------------------------------------------------------

describe('handleSpConfirmationTimeout', () => {
  test('clears background timeout when message.id is a string', () => {
    handleSpConfirmationTimeout({ id: 'conf-1' }, () => {});

    expect(mockClearConfirmationBackgroundTimeout).toHaveBeenCalledWith('conf-1');
  });

  test('does NOT call clearConfirmationBackgroundTimeout when id is not a string', () => {
    handleSpConfirmationTimeout({ id: 123 }, () => {});

    expect(mockClearConfirmationBackgroundTimeout).not.toHaveBeenCalled();
  });

  test('always calls clearConfirmationBadge', () => {
    handleSpConfirmationTimeout({}, () => {});

    expect(mockClearConfirmationBadge).toHaveBeenCalledOnce();
  });

  test('sendResponse is called with { ok: true }', () => {
    const sendResponse = vi.fn();
    handleSpConfirmationTimeout({}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleBgGetConnectionState
// ---------------------------------------------------------------------------

describe('handleBgGetConnectionState', () => {
  test('returns connected=false when not connected', () => {
    const sendResponse = vi.fn();
    handleBgGetConnectionState({}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
  });

  test('returns connected=true after connect', () => {
    handleWsState({ connected: true }, () => {});
    vi.clearAllMocks();

    const sendResponse = vi.fn();
    handleBgGetConnectionState({}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
  });
});
