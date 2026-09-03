import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — set up before importing iife-injection.ts so that the
// exported functions bind to the mocked versions of dependencies.
// ---------------------------------------------------------------------------

vi.mock('./constants.js', () => ({
  INJECTION_RETRY_DELAY_MS: 0,
  isValidPluginName: (name: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name),
}));

vi.mock('./plugin-storage.js', () => ({
  storePluginsBatch: vi.fn(),
  removePlugin: vi.fn(),
  removePluginsBatch: vi.fn(),
  getAllPluginMeta: vi.fn(),
  getPluginMeta: vi.fn(),
  invalidatePluginCache: vi.fn(),
}));

vi.mock('./tab-matching.js', async importOriginal => ({
  // isTabScriptable is a pure predicate; the real implementation is kept so
  // injection tests exercise the discarded/frozen/unloaded filter.
  isTabScriptable: (await importOriginal<typeof import('./tab-matching.js')>()).isTabScriptable,
  urlMatchesPatterns: vi.fn(),
  matchPattern: vi.fn(),
  findAllMatchingTabs: vi.fn(),
  findMatchingTab: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

const mockTabsQuery = vi.fn<(queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>>();
const mockExecuteScript = vi.fn<(injection: unknown) => Promise<Array<{ result?: unknown }>>>();
const mockRuntimeSendMessage = vi.fn<(message: unknown) => Promise<void>>(() => Promise.resolve());

(globalThis as Record<string, unknown>).chrome = {
  tabs: { query: mockTabsQuery },
  scripting: { executeScript: mockExecuteScript },
  runtime: { sendMessage: mockRuntimeSendMessage },
};

// The ISOLATED-world relay closures reference `window` and `document`. Tests
// run under Node, so both are faked on globalThis; `window` is (re)installed
// per test by the describes that execute ISOLATED funcs.
const mockAddEventListener = vi.fn<(type: string, listener: (event: unknown) => void) => void>();
(globalThis as Record<string, unknown>).document = { addEventListener: mockAddEventListener };

// Import after mocking
const { isSafePluginName, queryMatchingTabIds, injectPluginIntoMatchingTabs, cspViolationRelayScript } = await import(
  './iife-injection.js'
);
const { CSP_RELAY_DIRECTIVES, MAX_CSP_VIOLATIONS_PER_DOCUMENT } = await import('./csp-violation.js');

// ---------------------------------------------------------------------------
// isSafePluginName
// ---------------------------------------------------------------------------

describe('isSafePluginName', () => {
  test('accepts valid lowercase plugin names', () => {
    expect(isSafePluginName('slack')).toBe(true);
    expect(isSafePluginName('my-plugin')).toBe(true);
    expect(isSafePluginName('plugin123')).toBe(true);
  });

  test('rejects reserved names', () => {
    expect(isSafePluginName('system')).toBe(false);
    expect(isSafePluginName('browser')).toBe(false);
    expect(isSafePluginName('opentabs')).toBe(false);
    expect(isSafePluginName('extension')).toBe(false);
    expect(isSafePluginName('config')).toBe(false);
    expect(isSafePluginName('plugin')).toBe(false);
    expect(isSafePluginName('tool')).toBe(false);
    expect(isSafePluginName('mcp')).toBe(false);
  });

  test('rejects invalid plugin name formats', () => {
    expect(isSafePluginName('')).toBe(false);
    expect(isSafePluginName('UPPERCASE')).toBe(false);
    expect(isSafePluginName('has spaces')).toBe(false);
    expect(isSafePluginName('-leading-dash')).toBe(false);
    expect(isSafePluginName('trailing-dash-')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queryMatchingTabIds
// ---------------------------------------------------------------------------

describe('queryMatchingTabIds', () => {
  beforeEach(() => {
    mockTabsQuery.mockReset();
  });

  test('returns tab IDs matching a single URL pattern', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab,
      { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab,
    ]);

    const result = await queryMatchingTabIds(['*://example.com/*']);
    expect(result).toEqual([1, 2]);
    expect(mockTabsQuery).toHaveBeenCalledTimes(1);
    expect(mockTabsQuery).toHaveBeenCalledWith({ url: '*://example.com/*' });
  });

  test('deduplicates tab IDs across multiple patterns', async () => {
    mockTabsQuery.mockImplementation((queryInfo: chrome.tabs.QueryInfo) => {
      if (queryInfo.url === '*://example.com/*') {
        return Promise.resolve([
          { id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab,
          { id: 2, url: 'https://example.com/b' } as chrome.tabs.Tab,
        ]);
      }
      if (queryInfo.url === '*://example.com/a') {
        return Promise.resolve([{ id: 1, url: 'https://example.com/a' } as chrome.tabs.Tab]);
      }
      return Promise.resolve([]);
    });

    const result = await queryMatchingTabIds(['*://example.com/*', '*://example.com/a']);
    expect(result).toEqual([1, 2]);
  });

  test('returns empty array for no matching tabs', async () => {
    mockTabsQuery.mockResolvedValue([]);
    const result = await queryMatchingTabIds(['*://nonexistent.com/*']);
    expect(result).toEqual([]);
  });

  test('skips tabs without an id', async () => {
    mockTabsQuery.mockResolvedValue([
      { url: 'https://example.com/a' } as chrome.tabs.Tab,
      { id: 3, url: 'https://example.com/b' } as chrome.tabs.Tab,
    ]);

    const result = await queryMatchingTabIds(['*://example.com/*']);
    expect(result).toEqual([3]);
  });

  test('skips tabs Chrome cannot script (discarded, frozen, unloaded)', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/a', discarded: true } as chrome.tabs.Tab,
      { id: 2, url: 'https://example.com/b', frozen: true } as chrome.tabs.Tab,
      { id: 3, url: 'https://example.com/c', status: 'unloaded' } as chrome.tabs.Tab,
      { id: 4, url: 'https://example.com/d', status: 'complete' } as chrome.tabs.Tab,
    ]);

    const result = await queryMatchingTabIds(['*://example.com/*']);
    expect(result).toEqual([4]);
  });

  test('returns empty array for empty URL patterns', async () => {
    const result = await queryMatchingTabIds([]);
    expect(result).toEqual([]);
    expect(mockTabsQuery).not.toHaveBeenCalled();
  });

  test('handles chrome.tabs.query failure gracefully', async () => {
    mockTabsQuery.mockRejectedValue(new Error('Invalid URL pattern'));
    const result = await queryMatchingTabIds(['invalid-pattern']);
    expect(result).toEqual([]);
  });

  test('continues with other patterns when one pattern fails', async () => {
    let callCount = 0;
    mockTabsQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('bad pattern'));
      return Promise.resolve([{ id: 5, url: 'https://good.com/page' } as chrome.tabs.Tab]);
    });

    const result = await queryMatchingTabIds(['bad-pattern', '*://good.com/*']);
    expect(result).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------
// injectLogRelay nonce management
// ---------------------------------------------------------------------------

describe('injectLogRelay nonce management', () => {
  let fakeWindow: Record<string, unknown>;

  beforeEach(() => {
    mockTabsQuery.mockReset();
    mockExecuteScript.mockReset();
    mockAddEventListener.mockReset();
    // Provide a fake window for the ISOLATED world func to run against.
    // The ISOLATED world content script accesses `window` — in Node test
    // context we set it on globalThis so the reference resolves.
    fakeWindow = {};
    (globalThis as Record<string, unknown>).window = fakeWindow;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  test('replaces stale nonces with the new nonce on re-injection', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 42 } as chrome.tabs.Tab]);

    // Execute ISOLATED world funcs in the fake window context;
    // return generic results for all MAIN world calls.
    let isolatedCallCount = 0;
    mockExecuteScript.mockImplementation((raw: unknown) => {
      const injection = raw as Record<string, unknown>;
      if (injection.world === 'ISOLATED') {
        isolatedCallCount++;
        const func = injection.func as (...args: unknown[]) => void;
        const args = (injection.args as unknown[] | undefined) ?? [];
        func(...args);
      }
      return Promise.resolve([{ result: undefined }]);
    });

    // First injection: creates the guard + nonces Set with nonce1
    await injectPluginIntoMatchingTabs('slack', ['*://slack.com/*'], true);
    const nonces = fakeWindow.__opentabs_log_nonces as Set<string>;
    expect(nonces).toBeDefined();
    expect(nonces.size).toBe(1);
    const nonce1 = [...nonces][0];

    // Second injection: should clear nonce1 and store only nonce2
    await injectPluginIntoMatchingTabs('slack', ['*://slack.com/*'], true);
    expect(nonces.size).toBe(1);
    const nonce2 = [...nonces][0];
    expect(nonce2).not.toBe(nonce1);

    // 2 injections × 3 ISOLATED calls each (log relay + readiness relay + CSP violation relay)
    expect(isolatedCallCount).toBe(6);
  });

  test('installs the CSP violation relay with the shared allow-list and cap as args', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 42 } as chrome.tabs.Tab]);
    mockExecuteScript.mockResolvedValue([{ result: undefined }]);

    await injectPluginIntoMatchingTabs('slack', ['*://slack.com/*'], true);

    const relayCall = mockExecuteScript.mock.calls
      .map(call => call[0] as { world?: string; func?: unknown; args?: unknown[] })
      .find(injection => injection.world === 'ISOLATED' && injection.func === cspViolationRelayScript);
    expect(relayCall).toBeDefined();
    expect(relayCall?.args).toEqual([CSP_RELAY_DIRECTIVES, MAX_CSP_VIOLATIONS_PER_DOCUMENT]);
  });

  test('nonces Set always has exactly one entry regardless of injection count', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 42 } as chrome.tabs.Tab]);

    mockExecuteScript.mockImplementation((raw: unknown) => {
      const injection = raw as Record<string, unknown>;
      if (injection.world === 'ISOLATED') {
        const func = injection.func as (...args: unknown[]) => void;
        const args = (injection.args as unknown[] | undefined) ?? [];
        func(...args);
      }
      return Promise.resolve([{ result: undefined }]);
    });

    for (let i = 0; i < 10; i++) {
      await injectPluginIntoMatchingTabs('slack', ['*://slack.com/*'], true);
    }

    const nonces = fakeWindow.__opentabs_log_nonces as Set<string>;
    expect(nonces.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cspViolationRelayScript — the ISOLATED-world securitypolicyviolation listener
// ---------------------------------------------------------------------------

describe('cspViolationRelayScript', () => {
  type Listener = (event: SecurityPolicyViolationEvent) => void;

  const baseEvent = {
    isTrusted: true,
    effectiveDirective: 'connect-src',
    blockedURI: 'https://127.0.0.1:9515/mcp?x=1',
    documentURI: 'https://outlook.office.com/mail/inbox/id/AAMk',
    sourceFile: 'chrome-extension://abc/adapters/outlook-1234abcd.js',
    lineNumber: 12,
    columnNumber: 34,
    disposition: 'enforce',
  };

  const makeEvent = (overrides: Partial<typeof baseEvent> = {}): SecurityPolicyViolationEvent =>
    ({ ...baseEvent, ...overrides }) as unknown as SecurityPolicyViolationEvent;

  /** Install the relay against the fakes and return the registered listener. */
  const installRelay = (): Listener => {
    cspViolationRelayScript(CSP_RELAY_DIRECTIVES, MAX_CSP_VIOLATIONS_PER_DOCUMENT);
    const registration = mockAddEventListener.mock.calls[0];
    if (!registration) throw new Error('relay registered no listener');
    return registration[1] as unknown as Listener;
  };

  const sentReports = (): Array<Record<string, unknown>> =>
    mockRuntimeSendMessage.mock.calls.map(call => (call[0] as { report: Record<string, unknown> }).report);

  beforeEach(() => {
    mockAddEventListener.mockReset();
    mockRuntimeSendMessage.mockClear();
    (globalThis as Record<string, unknown>).window = {};
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  test('registers exactly one securitypolicyviolation listener per document', () => {
    installRelay();
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener.mock.calls[0]?.[0]).toBe('securitypolicyviolation');

    cspViolationRelayScript(CSP_RELAY_DIRECTIVES, MAX_CSP_VIOLATIONS_PER_DOCUMENT);
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
  });

  test('relays a trusted connect-src violation with URIs reduced to origins', () => {
    const listener = installRelay();
    listener(makeEvent());

    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRuntimeSendMessage.mock.calls[0]?.[0]).toEqual({
      type: 'csp:violation',
      report: {
        effectiveDirective: 'connect-src',
        blockedURI: 'https://127.0.0.1:9515',
        sourceFile: 'chrome-extension://abc/adapters/outlook-1234abcd.js',
        lineNumber: 12,
        columnNumber: 34,
        disposition: 'enforce',
        documentOrigin: 'https://outlook.office.com',
      },
    });
  });

  test('ignores untrusted (page-constructed) events', () => {
    const listener = installRelay();
    listener(makeEvent({ isTrusted: false }));
    expect(mockRuntimeSendMessage).not.toHaveBeenCalled();
  });

  test('ignores directives outside the allow-list', () => {
    const listener = installRelay();
    listener(makeEvent({ effectiveDirective: 'img-src' }));
    listener(makeEvent({ effectiveDirective: 'style-src-elem' }));
    expect(mockRuntimeSendMessage).not.toHaveBeenCalled();
  });

  test('relays a trusted-types violation attributed to its source file', () => {
    const listener = installRelay();
    listener(makeEvent({ effectiveDirective: 'require-trusted-types-for', blockedURI: 'trusted-types-sink' }));
    expect(sentReports()[0]).toMatchObject({
      effectiveDirective: 'require-trusted-types-for',
      blockedURI: 'trusted-types-sink',
      sourceFile: 'chrome-extension://abc/adapters/outlook-1234abcd.js',
    });
  });

  test('reduces a page-script sourceFile to its origin', () => {
    const listener = installRelay();
    listener(makeEvent({ sourceFile: 'https://outlook.office.com/mail/app.js' }));
    expect(sentReports()[0]?.sourceFile).toBe('https://outlook.office.com');
  });

  test('forwards a non-URL blockedURI as-is', () => {
    const listener = installRelay();
    listener(makeEvent({ blockedURI: 'inline' }));
    expect(sentReports()[0]?.blockedURI).toBe('inline');
  });

  test('dedupes by directive, blocked origin, source file, and disposition', () => {
    const listener = installRelay();
    listener(makeEvent());
    listener(makeEvent({ blockedURI: 'https://127.0.0.1:9515/other' }));
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(1);

    listener(makeEvent({ disposition: 'report' }));
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(2);

    listener(makeEvent({ sourceFile: 'https://outlook.office.com/mail/app.js' }));
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(3);
  });

  test('caps relayed reports at the per-document maximum', () => {
    const listener = installRelay();
    for (let i = 0; i < 25; i++) {
      listener(makeEvent({ blockedURI: `https://host-${i}.example.com/path` }));
    }
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(MAX_CSP_VIOLATIONS_PER_DOCUMENT);
  });

  test('repeats never consume the per-document budget', () => {
    const listener = installRelay();
    for (let i = 0; i < 30; i++) listener(makeEvent());
    for (let i = 0; i < 19; i++) {
      listener(makeEvent({ blockedURI: `https://host-${i}.example.com/path` }));
    }
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(20);
  });

  test('a rejected sendMessage is swallowed', () => {
    mockRuntimeSendMessage.mockImplementationOnce(() => Promise.reject(new Error('no receiver')));
    const listener = installRelay();
    expect(() => listener(makeEvent())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// skipIfHashMatches — hash-based injection skip for sync.full reconnect
// ---------------------------------------------------------------------------

describe('skipIfHashMatches', () => {
  beforeEach(() => {
    mockTabsQuery.mockReset();
    mockExecuteScript.mockReset();
  });

  /**
   * Helper: configure mockExecuteScript to return `preInjectionHash` for the
   * first readAdapterHash call per tab (the skipIfHashMatches check), and
   * return the `adapterHash` argument (the expected hash) for subsequent
   * reads (verifyAdapterHash after file injection).
   */
  const setupHashMock = (preInjectionHash: string | undefined, postInjectionHash?: string) => {
    const fileInjections: Array<{ tabId: number; files: string[] }> = [];
    // Track per-tab whether file injection has occurred (so post-injection
    // readAdapterHash returns the "newly injected" hash).
    const injectedTabs = new Set<number>();

    mockExecuteScript.mockImplementation((raw: unknown) => {
      const injection = raw as Record<string, unknown>;
      const target = injection.target as { tabId: number } | undefined;
      const tabId = target?.tabId ?? -1;

      // File-based injection (injectAdapterFile)
      if (injection.files) {
        fileInjections.push({ tabId, files: injection.files as string[] });
        injectedTabs.add(tabId);
        return Promise.resolve([{ result: undefined }]);
      }

      // readAdapterHash / isAdapterPresent: MAIN world func with a single pluginName arg
      const world = injection.world as string | undefined;
      const args = injection.args as unknown[] | undefined;
      if (world === 'MAIN' && injection.func && args?.length === 1 && typeof args[0] === 'string') {
        // After file injection, return the post-injection hash for verifyAdapterHash
        if (injectedTabs.has(tabId) && postInjectionHash !== undefined) {
          return Promise.resolve([{ result: postInjectionHash }]);
        }
        return Promise.resolve([{ result: preInjectionHash }]);
      }

      // All other func-based calls (log relay, prepareForReinjection, etc.)
      return Promise.resolve([{ result: undefined }]);
    });

    return { fileInjections };
  };

  test('skips injection when adapter hash matches skipIfHashMatches', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 } as chrome.tabs.Tab]);
    const { fileInjections } = setupHashMock('abc123');

    const result = await injectPluginIntoMatchingTabs(
      'slack',
      ['*://slack.com/*'],
      true, // forceReinject
      'abc123', // adapterHash
      undefined, // adapterFile
      'abc123', // skipIfHashMatches
    );

    expect(result).toEqual([10]);
    // No file-based injection should have occurred
    expect(fileInjections).toHaveLength(0);
  });

  test('proceeds with injection when adapter hash does not match skipIfHashMatches', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 } as chrome.tabs.Tab]);
    const { fileInjections } = setupHashMock('old-hash', 'new-hash');

    const result = await injectPluginIntoMatchingTabs(
      'slack',
      ['*://slack.com/*'],
      true, // forceReinject
      'new-hash', // adapterHash
      undefined, // adapterFile
      'new-hash', // skipIfHashMatches
    );

    expect(result).toEqual([10]);
    // File injection should have happened since hashes differ
    expect(fileInjections).toHaveLength(1);
    expect(fileInjections[0]?.tabId).toBe(10);
  });

  test('proceeds with injection when adapter has no hash (not yet injected)', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 } as chrome.tabs.Tab]);
    const { fileInjections } = setupHashMock(undefined, 'abc123');

    const result = await injectPluginIntoMatchingTabs(
      'slack',
      ['*://slack.com/*'],
      true, // forceReinject
      'abc123', // adapterHash
      undefined, // adapterFile
      'abc123', // skipIfHashMatches
    );

    expect(result).toEqual([10]);
    // File injection should have happened since readAdapterHash returned undefined
    expect(fileInjections).toHaveLength(1);
  });

  test('does not skip when skipIfHashMatches is not provided (plugin.update path)', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 } as chrome.tabs.Tab]);
    const { fileInjections } = setupHashMock('abc123');

    const result = await injectPluginIntoMatchingTabs(
      'slack',
      ['*://slack.com/*'],
      true, // forceReinject
      'abc123', // adapterHash
      undefined, // adapterFile
      // skipIfHashMatches NOT provided — simulates plugin.update
    );

    expect(result).toEqual([10]);
    // File injection should have happened even though hash matches,
    // because skipIfHashMatches was not provided
    expect(fileInjections).toHaveLength(1);
  });

  test('skips some tabs and injects others based on individual hash checks', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 } as chrome.tabs.Tab, { id: 20 } as chrome.tabs.Tab]);

    const fileInjections: number[] = [];
    const injectedTabs = new Set<number>();

    mockExecuteScript.mockImplementation((raw: unknown) => {
      const injection = raw as Record<string, unknown>;
      const target = injection.target as { tabId: number } | undefined;
      const tabId = target?.tabId ?? -1;

      if (injection.files) {
        fileInjections.push(tabId);
        injectedTabs.add(tabId);
        return Promise.resolve([{ result: undefined }]);
      }

      const world = injection.world as string | undefined;
      const args = injection.args as unknown[] | undefined;
      if (world === 'MAIN' && injection.func && args?.length === 1 && typeof args[0] === 'string') {
        // After file injection, verifyAdapterHash should see the new hash
        if (injectedTabs.has(tabId)) return Promise.resolve([{ result: 'abc123' }]);
        // Tab 10 has the matching hash (will be skipped); tab 20 has a stale hash
        return Promise.resolve([{ result: tabId === 10 ? 'abc123' : 'stale-hash' }]);
      }

      return Promise.resolve([{ result: undefined }]);
    });

    const result = await injectPluginIntoMatchingTabs(
      'slack',
      ['*://slack.com/*'],
      true,
      'abc123',
      undefined,
      'abc123',
    );

    expect(result).toEqual([10, 20]);
    // Only tab 20 should have been injected (tab 10 was skipped due to matching hash)
    expect(fileInjections).toEqual([20]);
  });
});
