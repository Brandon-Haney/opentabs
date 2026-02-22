import { PLUGINS_META_KEY } from './constants.js';
import {
  storePluginsBatch,
  removePlugin,
  removePluginsBatch,
  getAllPluginMeta,
  getPluginMeta,
  invalidatePluginCache,
} from './plugin-storage.js';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { PluginMeta } from './extension-messages.js';

// ---------------------------------------------------------------------------
// In-memory mock of chrome.storage.local
// ---------------------------------------------------------------------------

let store: Record<string, unknown> = {};

const mockChromeStorage = {
  get: (keys: string | string[]): Promise<Record<string, unknown>> => {
    const keyList = typeof keys === 'string' ? [keys] : keys;
    const result: Record<string, unknown> = {};
    for (const k of keyList) {
      if (k in store) result[k] = store[k];
    }
    return Promise.resolve(result);
  },
  set: (items: Record<string, unknown>): Promise<void> => {
    Object.assign(store, items);
    return Promise.resolve();
  },
  remove: (keys: string | string[]): Promise<void> => {
    const keyList = typeof keys === 'string' ? [keys] : keys;
    for (const k of keyList) {
      store = Object.fromEntries(Object.entries(store).filter(([key]) => key !== k));
    }
    return Promise.resolve();
  },
};

(globalThis as Record<string, unknown>).chrome = {
  storage: { local: mockChromeStorage },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMeta = (name: string, overrides?: Partial<PluginMeta>): PluginMeta => ({
  name,
  version: '1.0.0',
  displayName: name,
  urlPatterns: ['*://example.com/*'],
  trustTier: 'local',
  tools: [{ name: 'test-tool', displayName: 'Test Tool', description: 'A test tool', icon: 'wrench', enabled: true }],
  ...overrides,
});

beforeEach(() => {
  store = {};
  invalidatePluginCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getAllPluginMeta', () => {
  test('returns empty object when storage is empty', async () => {
    const result = await getAllPluginMeta();
    expect(result).toEqual({});
  });

  test('returns empty object when storage key is missing', async () => {
    store = { unrelated: 'data' };
    const result = await getAllPluginMeta();
    expect(result).toEqual({});
  });

  test('returns empty object when stored value is not an object', async () => {
    store = { [PLUGINS_META_KEY]: 'not-an-object' };
    const result = await getAllPluginMeta();
    expect(result).toEqual({});
  });

  test('filters out corrupted entries', async () => {
    store = {
      [PLUGINS_META_KEY]: {
        valid: makeMeta('valid'),
        corrupted: { name: 'corrupted' }, // missing required fields
      },
    };
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['valid']);
    expect(result['valid']?.name).toBe('valid');
  });

  test('returns a copy (mutations do not affect cache)', async () => {
    await storePluginsBatch([makeMeta('alpha')]);
    const first = await getAllPluginMeta();
    first['injected'] = makeMeta('injected');
    const second = await getAllPluginMeta();
    expect(second['injected']).toBeUndefined();
  });
});

describe('getPluginMeta', () => {
  test('returns undefined for nonexistent plugin', async () => {
    const result = await getPluginMeta('nonexistent');
    expect(result).toBeUndefined();
  });

  test('returns the correct plugin meta', async () => {
    await storePluginsBatch([makeMeta('alpha'), makeMeta('beta')]);
    const result = await getPluginMeta('alpha');
    expect(result).toBeDefined();
    expect(result?.name).toBe('alpha');
  });
});

describe('storePluginsBatch', () => {
  test('stores a single plugin', async () => {
    await storePluginsBatch([makeMeta('my-plugin')]);
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['my-plugin']);
    expect(result['my-plugin']?.version).toBe('1.0.0');
  });

  test('stores multiple plugins in one call', async () => {
    await storePluginsBatch([makeMeta('alpha'), makeMeta('beta'), makeMeta('gamma')]);
    const result = await getAllPluginMeta();
    expect(Object.keys(result).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('merges with existing plugins', async () => {
    await storePluginsBatch([makeMeta('existing')]);
    await storePluginsBatch([makeMeta('new-plugin')]);
    const result = await getAllPluginMeta();
    expect(Object.keys(result).sort()).toEqual(['existing', 'new-plugin']);
  });

  test('overwrites existing plugin with same name', async () => {
    await storePluginsBatch([makeMeta('my-plugin', { version: '1.0.0' })]);
    await storePluginsBatch([makeMeta('my-plugin', { version: '2.0.0' })]);
    const result = await getAllPluginMeta();
    expect(result['my-plugin']?.version).toBe('2.0.0');
  });

  test('no-op when given empty array', async () => {
    await storePluginsBatch([makeMeta('existing')]);
    await storePluginsBatch([]);
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['existing']);
  });

  test('persists to chrome.storage.local', async () => {
    await storePluginsBatch([makeMeta('persisted')]);
    const rawData = store[PLUGINS_META_KEY] as Record<string, PluginMeta>;
    expect(rawData['persisted']?.name).toBe('persisted');
  });
});

describe('removePlugin', () => {
  test('removes an existing plugin', async () => {
    await storePluginsBatch([makeMeta('alpha'), makeMeta('beta')]);
    await removePlugin('alpha');
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['beta']);
  });

  test('no-op when plugin does not exist', async () => {
    await storePluginsBatch([makeMeta('alpha')]);
    await removePlugin('nonexistent');
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['alpha']);
  });

  test('removing last plugin leaves empty index', async () => {
    await storePluginsBatch([makeMeta('only')]);
    await removePlugin('only');
    const result = await getAllPluginMeta();
    expect(result).toEqual({});
  });
});

describe('removePluginsBatch', () => {
  test('removes multiple plugins in one call', async () => {
    await storePluginsBatch([makeMeta('alpha'), makeMeta('beta'), makeMeta('gamma')]);
    await removePluginsBatch(['alpha', 'gamma']);
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['beta']);
  });

  test('no-op when given empty array', async () => {
    await storePluginsBatch([makeMeta('alpha')]);
    await removePluginsBatch([]);
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['alpha']);
  });

  test('ignores nonexistent plugin names', async () => {
    await storePluginsBatch([makeMeta('alpha')]);
    await removePluginsBatch(['nonexistent', 'also-missing']);
    const result = await getAllPluginMeta();
    expect(Object.keys(result)).toEqual(['alpha']);
  });
});

describe('write serialization', () => {
  test('concurrent storePluginsBatch calls execute in order', async () => {
    // Both writes are issued concurrently (no await between them).
    // The serialize() mutex guarantees the second write sees the first write's result.
    const p1 = storePluginsBatch([makeMeta('first')]);
    const p2 = storePluginsBatch([makeMeta('second')]);
    await Promise.all([p1, p2]);

    const result = await getAllPluginMeta();
    expect(Object.keys(result).sort()).toEqual(['first', 'second']);
  });

  test('concurrent store and remove execute in order', async () => {
    await storePluginsBatch([makeMeta('to-remove')]);

    // Issue store + remove concurrently
    const p1 = storePluginsBatch([makeMeta('new-plugin')]);
    const p2 = removePlugin('to-remove');
    await Promise.all([p1, p2]);

    const result = await getAllPluginMeta();
    expect(result['new-plugin']).toBeDefined();
    expect(result['to-remove']).toBeUndefined();
  });

  test('three concurrent writes all succeed without data loss', async () => {
    const p1 = storePluginsBatch([makeMeta('alpha')]);
    const p2 = storePluginsBatch([makeMeta('beta')]);
    const p3 = storePluginsBatch([makeMeta('gamma')]);
    await Promise.all([p1, p2, p3]);

    const result = await getAllPluginMeta();
    expect(Object.keys(result).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('concurrent removePluginsBatch and storePluginsBatch serialize correctly', async () => {
    await storePluginsBatch([makeMeta('a'), makeMeta('b'), makeMeta('c')]);

    const p1 = removePluginsBatch(['a', 'b']);
    const p2 = storePluginsBatch([makeMeta('d')]);
    await Promise.all([p1, p2]);

    const result = await getAllPluginMeta();
    expect(result['a']).toBeUndefined();
    expect(result['b']).toBeUndefined();
    expect(result['c']).toBeDefined();
    expect(result['d']).toBeDefined();
  });

  test('failing write does not break the mutex chain', async () => {
    const originalSet = mockChromeStorage.set;

    // First call to set will reject (simulating a storage error)
    let callCount = 0;
    mockChromeStorage.set = (items: Record<string, unknown>): Promise<void> => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('storage quota exceeded'));
      }
      return originalSet(items);
    };

    // Fire two concurrent writes — the first fails, the second should still succeed
    const p1 = storePluginsBatch([makeMeta('will-fail')]);
    const p2 = storePluginsBatch([makeMeta('should-succeed')]);

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    // The first write rejects
    expect(r1.status).toBe('rejected');
    // The second write succeeds despite the first failure
    expect(r2.status).toBe('fulfilled');

    // Invalidate cache since the failed write left it in an unknown state
    invalidatePluginCache();
    const result = await getAllPluginMeta();
    expect(result['should-succeed']).toBeDefined();
    expect(result['will-fail']).toBeUndefined();

    // Restore original mock
    mockChromeStorage.set = originalSet;
  });
});

describe('invalidatePluginCache', () => {
  test('forces next read to hit chrome.storage.local', async () => {
    await storePluginsBatch([makeMeta('cached')]);

    // Replace the store entry entirely (simulating an external write that
    // bypasses the module's serialized write path). This creates a new object
    // reference that the in-memory cache does not know about.
    store[PLUGINS_META_KEY] = {
      cached: makeMeta('cached'),
      external: makeMeta('external'),
    };

    // Without invalidation, the cache still returns the old state
    const beforeInvalidate = await getAllPluginMeta();
    expect(beforeInvalidate['external']).toBeUndefined();

    // After invalidation, the fresh read from storage includes the external entry
    invalidatePluginCache();
    const afterInvalidate = await getAllPluginMeta();
    expect(afterInvalidate['external']).toBeDefined();
  });
});
