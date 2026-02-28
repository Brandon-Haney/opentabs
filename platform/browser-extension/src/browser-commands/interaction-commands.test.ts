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
  DEFAULT_WAIT_TIMEOUT_MS: 10000,
  POLL_INTERVAL_MS: 100,
  DEFAULT_QUERY_LIMIT: 100,
  TEXT_PREVIEW_MAX_LENGTH: 200,
}));

// Stub chrome.scripting so handler code that reaches past validation doesn't throw
const mockExecuteScript = vi.fn<(opts: unknown) => Promise<unknown[]>>().mockResolvedValue([]);
Object.assign(globalThis, {
  chrome: {
    ...((globalThis as Record<string, unknown>).chrome as object),
    runtime: { id: 'test-extension-id' },
    scripting: { executeScript: mockExecuteScript },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      ...((globalThis as Record<string, unknown>).chrome as { tabs?: object } | undefined)?.tabs,
      onRemoved: { addListener: vi.fn() },
    },
  },
});

// Import after mocking
const {
  handleBrowserClickElement,
  handleBrowserTypeText,
  handleBrowserSelectOption,
  handleBrowserWaitForElement,
  handleBrowserQueryElements,
  handleBrowserHoverElement,
  handleBrowserHandleDialog,
} = await import('./interaction-commands.js');

/** Extract the first argument from the first call to mockSendToServer */
const firstSentMessage = (): Record<string, unknown> => {
  const calls = mockSendToServer.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// handleBrowserClickElement
// ---------------------------------------------------------------------------

describe('handleBrowserClickElement', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserClickElement({ selector: '#btn' }, 'req-1');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects non-number tabId', async () => {
    await handleBrowserClickElement({ tabId: 'abc', selector: '#btn' }, 'req-2');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserClickElement({ tabId: 1 }, 'req-3');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-3',
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });

  test('rejects empty selector', async () => {
    await handleBrowserClickElement({ tabId: 1, selector: '' }, 'req-4');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserTypeText
// ---------------------------------------------------------------------------

describe('handleBrowserTypeText', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserTypeText({ selector: '#input', text: 'hello' }, 'req-10');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserTypeText({ tabId: 1, text: 'hello' }, 'req-11');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });

  test('rejects missing text', async () => {
    await handleBrowserTypeText({ tabId: 1, selector: '#input' }, 'req-12');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid text parameter' },
    });
  });

  test('rejects empty text', async () => {
    await handleBrowserTypeText({ tabId: 1, selector: '#input', text: '' }, 'req-13');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects non-string text', async () => {
    await handleBrowserTypeText({ tabId: 1, selector: '#input', text: 42 }, 'req-14');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserSelectOption
// ---------------------------------------------------------------------------

describe('handleBrowserSelectOption', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserSelectOption({ selector: 'select', value: 'a' }, 'req-20');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserSelectOption({ tabId: 1, value: 'a' }, 'req-21');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });

  test('rejects missing both value and label', async () => {
    await handleBrowserSelectOption({ tabId: 1, selector: 'select' }, 'req-22');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-22',
      error: { code: -32602, message: 'At least one of value or label must be provided' },
    });
  });

  test('rejects non-string value and label', async () => {
    await handleBrowserSelectOption({ tabId: 1, selector: 'select', value: 42, label: true }, 'req-23');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'At least one of value or label must be provided' },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserWaitForElement
// ---------------------------------------------------------------------------

describe('handleBrowserWaitForElement', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserWaitForElement({ selector: '#el' }, 'req-30');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserWaitForElement({ tabId: 1 }, 'req-31');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserQueryElements
// ---------------------------------------------------------------------------

describe('handleBrowserQueryElements', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserQueryElements({ selector: 'div' }, 'req-40');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserQueryElements({ tabId: 1 }, 'req-41');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserHoverElement
// ---------------------------------------------------------------------------

describe('handleBrowserHoverElement', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserHoverElement({ selector: '#btn' }, 'req-50');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing selector', async () => {
    await handleBrowserHoverElement({ tabId: 1 }, 'req-51');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });
});

// ---------------------------------------------------------------------------
// handleBrowserHandleDialog
// ---------------------------------------------------------------------------

describe('handleBrowserHandleDialog', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
    mockExecuteScript.mockReset();
  });

  test('rejects missing tabId', async () => {
    await handleBrowserHandleDialog({ action: 'accept' }, 'req-60');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('rejects missing action', async () => {
    await handleBrowserHandleDialog({ tabId: 1 }, 'req-61');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602, message: 'Missing or invalid action parameter' },
    });
  });

  test('rejects empty action', async () => {
    await handleBrowserHandleDialog({ tabId: 1, action: '' }, 'req-62');
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects invalid action value', async () => {
    await handleBrowserHandleDialog({ tabId: 1, action: 'cancel' }, 'req-63');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-63',
      error: { code: -32602, message: "action must be 'accept' or 'dismiss'" },
    });
  });
});
