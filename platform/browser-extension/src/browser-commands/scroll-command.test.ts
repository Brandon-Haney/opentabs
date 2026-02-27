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

vi.mock('../constants.js', () => ({
  TEXT_PREVIEW_MAX_LENGTH: 200,
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
const { handleBrowserScroll } = await import('./scroll-command.js');

/** Extract the first argument from the first call to mockSendToServer */
const firstSentMessage = (): Record<string, unknown> => {
  const calls = mockSendToServer.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// handleBrowserScroll
// ---------------------------------------------------------------------------

describe('handleBrowserScroll', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserScroll({ direction: 'down' }, 'req-1');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects non-number tabId', async () => {
    await handleBrowserScroll({ tabId: 'abc', direction: 'down' }, 'req-2');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects invalid direction value', async () => {
    await handleBrowserScroll({ tabId: 1, direction: 'diagonal' }, 'req-3');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-3',
      error: { code: -32602, message: 'Invalid direction: "diagonal". Must be one of: up, down, left, right' },
    });
  });

  test('rejects another invalid direction', async () => {
    await handleBrowserScroll({ tabId: 1, direction: 'sideways' }, 'req-4');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('accepts null direction (no direction param)', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { scrollPosition: { x: 0, y: 0 } } }]);
    await handleBrowserScroll({ tabId: 1 }, 'req-5');
    // Should proceed to executeScript, not send an error
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
  });

  test('accepts valid direction "up"', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { scrollPosition: { x: 0, y: 0 } } }]);
    await handleBrowserScroll({ tabId: 1, direction: 'up' }, 'req-6');
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
  });

  test('accepts valid direction "down"', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { scrollPosition: { x: 0, y: 0 } } }]);
    await handleBrowserScroll({ tabId: 1, direction: 'down' }, 'req-7');
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
  });

  test('accepts valid direction "left"', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { scrollPosition: { x: 0, y: 0 } } }]);
    await handleBrowserScroll({ tabId: 1, direction: 'left' }, 'req-8');
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
  });

  test('accepts valid direction "right"', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { scrollPosition: { x: 0, y: 0 } } }]);
    await handleBrowserScroll({ tabId: 1, direction: 'right' }, 'req-9');
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
  });
});
