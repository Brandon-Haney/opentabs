import { vi, describe, expect, test, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

const mockStorageSessionSet = vi.fn<(items: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
const mockStorageSessionGet = vi
  .fn<(keys: string | string[]) => Promise<Record<string, unknown>>>()
  .mockResolvedValue({});
const mockStorageSessionRemove = vi.fn<(keys: string | string[]) => Promise<void>>().mockResolvedValue(undefined);

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    session: {
      set: mockStorageSessionSet,
      get: mockStorageSessionGet,
      remove: mockStorageSessionRemove,
    },
  },
};

// Import after mocking
const {
  getCachesInitialized,
  getServerStateCache,
  setCachesInitialized,
  updateServerStateCache,
  clearServerStateCache,
  flushServerStateCacheToSession,
  loadServerStateCacheFromSession,
} = await import('./server-state-cache.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_CACHE = {
  plugins: [],
  failedPlugins: [],
  browserTools: [],
  serverVersion: undefined,
};

// ---------------------------------------------------------------------------
// get / update / clear behavior
// ---------------------------------------------------------------------------

describe('get / update / clear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('getServerStateCache returns empty cache initially', () => {
    expect(getServerStateCache()).toEqual(EMPTY_CACHE);
  });

  test('updateServerStateCache merges partial update', () => {
    updateServerStateCache({ serverVersion: '1.2.3' });
    expect(getServerStateCache().serverVersion).toBe('1.2.3');
    expect(getServerStateCache().plugins).toEqual([]);
  });

  test('updateServerStateCache preserves fields not in the partial', () => {
    const plugin = { name: 'test', displayName: 'Test', version: '1.0.0' } as never;
    updateServerStateCache({ plugins: [plugin] });
    updateServerStateCache({ serverVersion: '2.0.0' });
    expect(getServerStateCache().plugins).toEqual([plugin]);
    expect(getServerStateCache().serverVersion).toBe('2.0.0');
  });

  test('clearServerStateCache resets to empty', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    clearServerStateCache();
    expect(getServerStateCache()).toEqual(EMPTY_CACHE);
  });
});

// ---------------------------------------------------------------------------
// Debounced session storage writes
// ---------------------------------------------------------------------------

describe('debounced session storage writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('update does not write to session storage immediately', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    expect(mockStorageSessionSet).not.toHaveBeenCalled();
  });

  test('update writes to session storage after 500ms debounce', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    vi.advanceTimersByTime(500);
    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);
    const written = mockStorageSessionSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toHaveProperty('serverStateCache');
    expect(written.serverStateCache).toMatchObject({ serverVersion: '1.0.0' });
  });

  test('rapid updates are coalesced into a single write', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    vi.advanceTimersByTime(200);
    updateServerStateCache({ serverVersion: '2.0.0' });
    vi.advanceTimersByTime(200);
    updateServerStateCache({ serverVersion: '3.0.0' });
    vi.advanceTimersByTime(500);

    // Only one write fires, containing the final merged state
    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);
    const written = mockStorageSessionSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toHaveProperty('serverStateCache');
    expect(written.serverStateCache).toMatchObject({ serverVersion: '3.0.0' });
  });

  test('clearServerStateCache cancels pending debounce and removes from session', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    clearServerStateCache();

    // Advance past debounce — the pending write should NOT fire
    vi.advanceTimersByTime(500);
    expect(mockStorageSessionSet).not.toHaveBeenCalled();

    // But session remove was called (removes both cache and cachesInitialized)
    expect(mockStorageSessionRemove).toHaveBeenCalledWith(['serverStateCache', 'cachesInitialized']);
  });
});

// ---------------------------------------------------------------------------
// Session storage load
// ---------------------------------------------------------------------------

describe('loadServerStateCacheFromSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionGet.mockClear();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('populates in-memory cache from session storage', async () => {
    const stored = {
      plugins: [{ name: 'slack', displayName: 'Slack', version: '1.0.0', tools: [] }],
      failedPlugins: [{ name: 'broken', error: 'oops' }],
      browserTools: [{ name: 'screenshot', enabled: true }],
      serverVersion: '4.5.6',
    };
    mockStorageSessionGet.mockResolvedValue({ serverStateCache: stored });

    await loadServerStateCacheFromSession();

    const cache = getServerStateCache();
    expect(cache.plugins).toEqual(stored.plugins);
    expect(cache.failedPlugins).toEqual(stored.failedPlugins);
    expect(cache.browserTools).toEqual(stored.browserTools);
    expect(cache.serverVersion).toBe('4.5.6');
  });

  test('handles empty session storage gracefully', async () => {
    mockStorageSessionGet.mockResolvedValue({});

    await loadServerStateCacheFromSession();

    expect(getServerStateCache()).toEqual(EMPTY_CACHE);
  });

  test('handles session storage read failure gracefully', async () => {
    mockStorageSessionGet.mockRejectedValue(new Error('storage unavailable'));

    await loadServerStateCacheFromSession();

    expect(getServerStateCache()).toEqual(EMPTY_CACHE);
  });

  test('validates stored data shape — ignores invalid plugins field', async () => {
    mockStorageSessionGet.mockResolvedValue({
      serverStateCache: {
        plugins: 'not-an-array',
        failedPlugins: [],
        browserTools: [],
        serverVersion: '1.0.0',
      },
    });

    await loadServerStateCacheFromSession();

    expect(getServerStateCache().plugins).toEqual([]);
    expect(getServerStateCache().serverVersion).toBe('1.0.0');
  });

  test('validates serverVersion — ignores non-string values', async () => {
    mockStorageSessionGet.mockResolvedValue({
      serverStateCache: {
        plugins: [],
        failedPlugins: [],
        browserTools: [],
        serverVersion: 42,
      },
    });

    await loadServerStateCacheFromSession();

    expect(getServerStateCache().serverVersion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Immediate flush
// ---------------------------------------------------------------------------

describe('flushServerStateCacheToSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('writes to session storage immediately without waiting for debounce', () => {
    updateServerStateCache({ serverVersion: '1.0.0' });
    // No debounce timer has fired yet
    expect(mockStorageSessionSet).not.toHaveBeenCalled();

    flushServerStateCacheToSession();

    // Written immediately — no need to advance timers
    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);
    const written = mockStorageSessionSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toHaveProperty('serverStateCache');
    expect((written.serverStateCache as { serverVersion: string }).serverVersion).toBe('1.0.0');
  });

  test('cancels pending debounce timer so it does not fire a second write', () => {
    updateServerStateCache({ serverVersion: '2.0.0' });
    flushServerStateCacheToSession();

    // One write from the flush
    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);

    // Advance past the debounce window — no second write should fire
    vi.advanceTimersByTime(500);
    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cachesInitialized flag
// ---------------------------------------------------------------------------

describe('cachesInitialized flag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionGet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('getCachesInitialized returns false initially', () => {
    expect(getCachesInitialized()).toBe(false);
  });

  test('setCachesInitialized sets the flag to true', () => {
    setCachesInitialized(true);
    expect(getCachesInitialized()).toBe(true);
  });

  test('clearServerStateCache resets cachesInitialized to false', () => {
    setCachesInitialized(true);
    clearServerStateCache();
    expect(getCachesInitialized()).toBe(false);
  });

  test('clearServerStateCache removes cachesInitialized from session storage', () => {
    setCachesInitialized(true);
    clearServerStateCache();
    expect(mockStorageSessionRemove).toHaveBeenCalledWith(['serverStateCache', 'cachesInitialized']);
  });

  test('flushServerStateCacheToSession persists cachesInitialized alongside the cache', () => {
    setCachesInitialized(true);
    updateServerStateCache({ serverVersion: '1.0.0' });
    flushServerStateCacheToSession();

    expect(mockStorageSessionSet).toHaveBeenCalledTimes(1);
    const written = mockStorageSessionSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toHaveProperty('cachesInitialized', true);
  });

  test('loadServerStateCacheFromSession restores cachesInitialized from session storage', async () => {
    mockStorageSessionGet.mockResolvedValue({
      serverStateCache: {
        plugins: [],
        failedPlugins: [],
        browserTools: [],
        serverVersion: '1.0.0',
      },
      cachesInitialized: true,
    });

    await loadServerStateCacheFromSession();

    expect(getCachesInitialized()).toBe(true);
  });

  test('loadServerStateCacheFromSession defaults cachesInitialized to false when not in session', async () => {
    setCachesInitialized(true);
    // Session storage has no cachesInitialized key — clear first to reset
    clearServerStateCache();
    mockStorageSessionGet.mockClear();
    mockStorageSessionGet.mockResolvedValue({
      serverStateCache: {
        plugins: [],
        failedPlugins: [],
        browserTools: [],
      },
    });

    await loadServerStateCacheFromSession();

    expect(getCachesInitialized()).toBe(false);
  });
});
