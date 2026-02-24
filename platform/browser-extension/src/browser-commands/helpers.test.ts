import { mock, describe, expect, test, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing helpers.ts so that the exported
// functions bind to the mocked versions of dependencies.
// ---------------------------------------------------------------------------

const mockSendToServer = mock<(data: unknown) => void>();

await mock.module('../messaging.js', () => ({
  sendToServer: mockSendToServer,
  forwardToSidePanel: mock(),
}));

await mock.module('../sanitize-error.js', () => ({
  sanitizeErrorMessage: (msg: string) => msg,
}));

// Import after mocking
const {
  requireTabId,
  requireSelector,
  requireStringParam,
  requireUrl,
  extractScriptResult,
  sendErrorResult,
  sendValidationError,
  sendSuccessResult,
} = await import('./helpers.js');

/** Safely extract the first argument from the first call to mockSendToServer */
const firstSentMessage = (): Record<string, unknown> => {
  const calls = mockSendToServer.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  if (!firstCall) throw new Error('Expected at least one call');
  return firstCall[0] as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// requireTabId
// ---------------------------------------------------------------------------

describe('requireTabId', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('returns the tabId for a valid number', () => {
    const result = requireTabId({ tabId: 42 }, 'req-1');
    expect(result).toBe(42);
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32602 error for missing tabId', () => {
    const result = requireTabId({}, 'req-2');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-2',
      error: { code: -32602, message: 'Missing or invalid tabId parameter' },
    });
  });

  test('returns null and sends -32602 error for non-number tabId', () => {
    const result = requireTabId({ tabId: 'not-a-number' }, 'req-3');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-3',
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// requireSelector
// ---------------------------------------------------------------------------

describe('requireSelector', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('returns the selector for a valid non-empty string', () => {
    const result = requireSelector({ selector: '#main' }, 'req-10');
    expect(result).toBe('#main');
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32602 error for missing selector', () => {
    const result = requireSelector({}, 'req-11');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-11',
      error: { code: -32602, message: 'Missing or invalid selector parameter' },
    });
  });

  test('returns null and sends -32602 error for empty string', () => {
    const result = requireSelector({ selector: '' }, 'req-12');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-12',
      error: { code: -32602 },
    });
  });

  test('returns null and sends -32602 error for non-string selector', () => {
    const result = requireSelector({ selector: 123 }, 'req-13');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-13',
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// requireStringParam
// ---------------------------------------------------------------------------

describe('requireStringParam', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('returns the value for a valid non-empty string', () => {
    const result = requireStringParam({ plugin: 'slack' }, 'plugin', 'req-60');
    expect(result).toBe('slack');
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32602 error for missing param', () => {
    const result = requireStringParam({}, 'plugin', 'req-61');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-61',
      error: { code: -32602, message: 'Missing or invalid plugin parameter' },
    });
  });

  test('returns null and sends -32602 error for wrong type', () => {
    const result = requireStringParam({ plugin: 42 }, 'plugin', 'req-62');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-62',
      error: { code: -32602, message: 'Missing or invalid plugin parameter' },
    });
  });

  test('returns null and sends -32602 error for empty string', () => {
    const result = requireStringParam({ plugin: '' }, 'plugin', 'req-63');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-63',
      error: { code: -32602, message: 'Missing or invalid plugin parameter' },
    });
  });

  test('includes paramName in error message', () => {
    requireStringParam({}, 'execFile', 'req-64');
    expect(firstSentMessage()).toMatchObject({
      error: { message: 'Missing or invalid execFile parameter' },
    });
  });

  test('works with numeric id', () => {
    const result = requireStringParam({}, 'key', 99);
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// requireUrl
// ---------------------------------------------------------------------------

describe('requireUrl', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('returns the URL for a valid non-blocked URL', () => {
    const result = requireUrl({ url: 'https://example.com/page' }, 'req-20');
    expect(result).toBe('https://example.com/page');
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32602 error for missing url', () => {
    const result = requireUrl({}, 'req-21');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-21',
      error: { code: -32602, message: 'Missing or invalid url parameter' },
    });
  });

  test('returns null and sends -32602 error for non-string url', () => {
    const result = requireUrl({ url: 42 }, 'req-22');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-22',
      error: { code: -32602 },
    });
  });

  test('rejects javascript: scheme', () => {
    const result = requireUrl({ url: 'javascript:alert(1)' }, 'req-23');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-23',
      error: { code: -32602 },
    });
  });

  test('rejects data: scheme', () => {
    const result = requireUrl({ url: 'data:text/html,<h1>hi</h1>' }, 'req-24');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects file: scheme', () => {
    const result = requireUrl({ url: 'file:///etc/passwd' }, 'req-25');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects chrome: scheme', () => {
    const result = requireUrl({ url: 'chrome://settings' }, 'req-26');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });

  test('rejects blob: scheme', () => {
    const result = requireUrl({ url: 'blob:http://example.com/abc' }, 'req-27');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32602 },
    });
  });
});

// ---------------------------------------------------------------------------
// extractScriptResult
// ---------------------------------------------------------------------------

describe('extractScriptResult', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('extracts valid result from first element', () => {
    const result = extractScriptResult([{ result: { clicked: true, tagName: 'button' } }], 'req-30');
    expect(result).toEqual({ clicked: true, tagName: 'button' });
    expect(mockSendToServer).not.toHaveBeenCalled();
  });

  test('returns null and sends -32603 error for undefined result', () => {
    const result = extractScriptResult([{ result: undefined }], 'req-31');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-31',
      error: { code: -32603, message: 'No result from script execution' },
    });
  });

  test('returns null and sends -32603 error for empty results array', () => {
    const result = extractScriptResult([], 'req-32');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32603 },
    });
  });

  test('uses custom fallback message when provided', () => {
    const result = extractScriptResult([{}], 'req-33', 'Custom error message');
    expect(result).toBeNull();
    expect(firstSentMessage()).toMatchObject({
      error: { code: -32603, message: 'Custom error message' },
    });
  });

  test('returns null and sends -32602 error when result has error field', () => {
    const result = extractScriptResult([{ result: { error: 'Element not found' } }], 'req-34');
    expect(result).toBeNull();
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-34',
      error: { code: -32602, message: 'Element not found' },
    });
  });
});

// ---------------------------------------------------------------------------
// sendErrorResult
// ---------------------------------------------------------------------------

describe('sendErrorResult', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('sends -32603 error with sanitized message from Error', () => {
    sendErrorResult('req-40', new Error('Something went wrong'));
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-40',
      error: { code: -32603, message: 'Something went wrong' },
    });
  });

  test('sends -32603 error with string error', () => {
    sendErrorResult('req-41', 'String error');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-41',
      error: { code: -32603 },
    });
  });

  test('works with numeric id', () => {
    sendErrorResult(99, new Error('fail'));
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32603 },
    });
  });
});

// ---------------------------------------------------------------------------
// sendValidationError
// ---------------------------------------------------------------------------

describe('sendValidationError', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('sends -32602 error with provided message', () => {
    sendValidationError('req-45', 'Missing required field');
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-45',
      error: { code: -32602, message: 'Missing required field' },
    });
  });

  test('works with numeric id', () => {
    sendValidationError(77, 'Invalid parameter');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 77,
      error: { code: -32602, message: 'Invalid parameter' },
    });
  });
});

// ---------------------------------------------------------------------------
// sendSuccessResult
// ---------------------------------------------------------------------------

describe('sendSuccessResult', () => {
  beforeEach(() => {
    mockSendToServer.mockReset();
  });

  test('sends JSON-RPC 2.0 success response with result payload', () => {
    sendSuccessResult('req-50', { data: 'hello' });
    expect(mockSendToServer).toHaveBeenCalledTimes(1);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-50',
      result: { data: 'hello' },
    });
  });

  test('sends success response with null result', () => {
    sendSuccessResult('req-51', null);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-51',
      result: null,
    });
  });

  test('sends success response with array result', () => {
    sendSuccessResult('req-52', [1, 2, 3]);
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-52',
      result: [1, 2, 3],
    });
  });

  test('works with numeric id', () => {
    sendSuccessResult(42, 'ok');
    expect(firstSentMessage()).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      result: 'ok',
    });
  });
});
