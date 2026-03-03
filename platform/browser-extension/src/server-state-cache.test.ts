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
  addPendingAllBrowserToolsUpdate,
  addPendingBrowserToolUpdate,
  addPendingPluginAllToolsUpdate,
  addPendingPluginToolUpdate,
  getCachesInitialized,
  getServerStateCache,
  removePendingAllBrowserToolsUpdate,
  removePendingBrowserToolUpdate,
  removePendingPluginAllToolsUpdate,
  removePendingPluginToolUpdate,
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

  test('getServerStateCache returns a deep copy — mutating it does not affect the cache', () => {
    const plugin = { name: 'test', displayName: 'Test', version: '1.0.0' } as never;
    updateServerStateCache({ plugins: [plugin] });

    const snapshot = getServerStateCache();
    // Mutate the returned array
    (snapshot.plugins as unknown[]).push({ name: 'injected', displayName: 'Injected', version: '0.0.1' });

    // The internal cache should still contain only the original plugin
    expect(getServerStateCache().plugins).toHaveLength(1);
    expect(getServerStateCache().plugins[0]).toMatchObject({ name: 'test' });
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

// ---------------------------------------------------------------------------
// Pending optimistic updates — plugin tools
// ---------------------------------------------------------------------------

describe('pending optimistic plugin tool updates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('pending update survives a concurrent updateServerStateCache that overwrites the tool', () => {
    // Initial state: tool "send" is enabled
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    // User toggles "send" to disabled → register pending optimistic update
    addPendingPluginToolUpdate('slack', 'send', false);
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: false }],
        },
      ],
    });

    // Server sends plugins.changed with "send" still enabled (hasn't processed toggle yet)
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    // The pending optimistic update should have re-applied: send is still disabled
    const cache = getServerStateCache();
    expect(cache.plugins[0]?.tools[0]?.enabled).toBe(false);
  });

  test('after removing pending update, subsequent updateServerStateCache applies server value', () => {
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    addPendingPluginToolUpdate('slack', 'send', false);

    // Server responds successfully → clear pending update
    removePendingPluginToolUpdate('slack', 'send');

    // Next plugins.changed from server sets enabled=true
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    // No pending update → server value (true) is used
    const cache = getServerStateCache();
    expect(cache.plugins[0]?.tools[0]?.enabled).toBe(true);
  });

  test('addPendingPluginAllToolsUpdate protects all tools from concurrent update', () => {
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [
            { name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true },
            { name: 'read', displayName: 'Read', description: 'desc', icon: 'wrench', enabled: true },
          ],
        },
      ],
    });

    addPendingPluginAllToolsUpdate('slack', ['send', 'read'], false);

    // Server sends plugins.changed with both tools still enabled
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [
            { name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true },
            { name: 'read', displayName: 'Read', description: 'desc', icon: 'wrench', enabled: true },
          ],
        },
      ],
    });

    const cache = getServerStateCache();
    expect(cache.plugins[0]?.tools[0]?.enabled).toBe(false);
    expect(cache.plugins[0]?.tools[1]?.enabled).toBe(false);
  });

  test('removePendingPluginAllToolsUpdate clears all tool overrides', () => {
    addPendingPluginAllToolsUpdate('slack', ['send', 'read'], false);
    removePendingPluginAllToolsUpdate('slack', ['send', 'read']);

    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [
            { name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true },
            { name: 'read', displayName: 'Read', description: 'desc', icon: 'wrench', enabled: true },
          ],
        },
      ],
    });

    const cache = getServerStateCache();
    expect(cache.plugins[0]?.tools[0]?.enabled).toBe(true);
    expect(cache.plugins[0]?.tools[1]?.enabled).toBe(true);
  });

  test('clearServerStateCache clears pending plugin tool updates', () => {
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    addPendingPluginToolUpdate('slack', 'send', false);
    clearServerStateCache();

    // Re-populate after clear — the pending update should not re-apply
    updateServerStateCache({
      plugins: [
        {
          name: 'slack',
          displayName: 'Slack',
          version: '1.0.0',
          trustTier: 'community' as const,
          source: 'npm' as const,
          tabState: 'closed' as const,
          urlPatterns: [],
          tools: [{ name: 'send', displayName: 'Send', description: 'desc', icon: 'wrench', enabled: true }],
        },
      ],
    });

    expect(getServerStateCache().plugins[0]?.tools[0]?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pending optimistic updates — browser tools
// ---------------------------------------------------------------------------

describe('pending optimistic browser tool updates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerStateCache();
    mockStorageSessionSet.mockClear();
    mockStorageSessionRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('pending browser tool update survives a concurrent updateServerStateCache', () => {
    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: true },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    // User toggles screenshot disabled
    addPendingBrowserToolUpdate('screenshot', false);
    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: false },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    // Server sends plugins.changed with screenshot still enabled
    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: true },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    const cache = getServerStateCache();
    expect(cache.browserTools.find(bt => bt.name === 'screenshot')?.enabled).toBe(false);
    expect(cache.browserTools.find(bt => bt.name === 'console')?.enabled).toBe(true);
  });

  test('after removing pending browser tool update, server value applies', () => {
    addPendingBrowserToolUpdate('screenshot', false);
    removePendingBrowserToolUpdate('screenshot');

    updateServerStateCache({
      browserTools: [{ name: 'screenshot', description: 'Take a screenshot', enabled: true }],
    });

    expect(getServerStateCache().browserTools[0]?.enabled).toBe(true);
  });

  test('addPendingAllBrowserToolsUpdate protects all browser tools', () => {
    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: true },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    addPendingAllBrowserToolsUpdate(['screenshot', 'console'], false);

    // Server sends update with all enabled
    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: true },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    const cache = getServerStateCache();
    expect(cache.browserTools.every(bt => !bt.enabled)).toBe(true);
  });

  test('removePendingAllBrowserToolsUpdate clears all browser tool overrides', () => {
    addPendingAllBrowserToolsUpdate(['screenshot', 'console'], false);
    removePendingAllBrowserToolsUpdate(['screenshot', 'console']);

    updateServerStateCache({
      browserTools: [
        { name: 'screenshot', description: 'Take a screenshot', enabled: true },
        { name: 'console', description: 'Get console logs', enabled: true },
      ],
    });

    const cache = getServerStateCache();
    expect(cache.browserTools.every(bt => bt.enabled)).toBe(true);
  });

  test('clearServerStateCache clears pending browser tool updates', () => {
    addPendingBrowserToolUpdate('screenshot', false);
    clearServerStateCache();

    updateServerStateCache({
      browserTools: [{ name: 'screenshot', description: 'Take a screenshot', enabled: true }],
    });

    expect(getServerStateCache().browserTools[0]?.enabled).toBe(true);
  });
});
