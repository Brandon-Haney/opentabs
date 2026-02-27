import { vi, describe, expect, test, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing handler modules
// ---------------------------------------------------------------------------

const { mockSendToServer } = vi.hoisted(() => ({
  mockSendToServer: vi.fn<(data: unknown) => void>(),
}));

vi.mock('../messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: vi.fn(),
}));

vi.mock('../sanitize-error.js', () => ({
  sanitizeErrorMessage: (msg: string) => msg,
}));

// Stub chrome.scripting
const mockExecuteScript = vi.fn<(opts: unknown) => Promise<unknown[]>>().mockResolvedValue([]);
Object.assign(globalThis, {
  chrome: {
    ...((globalThis as Record<string, unknown>).chrome as object),
    runtime: { id: 'test-extension-id' },
    scripting: { executeScript: mockExecuteScript },
  },
});

// Import after mocking
const { handleBrowserPressKey } = await import('./key-press-command.js');

/** Extract the first argument from the first call to mockSendToServer */
const firstSentMessage = (): Record<string, unknown> => {
  const calls = mockSendToServer.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// handleBrowserPressKey
// ---------------------------------------------------------------------------

describe('handleBrowserPressKey', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserPressKey({ key: 'Enter' }, 'req-1');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects non-number tabId', async () => {
    await handleBrowserPressKey({ tabId: 'abc', key: 'Enter' }, 'req-2');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects missing key', async () => {
    await handleBrowserPressKey({ tabId: 1 }, 'req-3');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-3',
      error: { code: -32602, message: 'Missing or invalid key parameter' },
    });
  });

  test('rejects empty key', async () => {
    await handleBrowserPressKey({ tabId: 1, key: '' }, 'req-4');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects non-string key', async () => {
    await handleBrowserPressKey({ tabId: 1, key: 42 }, 'req-5');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('works with numeric id', async () => {
    await handleBrowserPressKey({ key: 'Enter' }, 99);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32602 },
    });
  });
});
