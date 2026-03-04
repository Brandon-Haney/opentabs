import { describe, expect, test } from 'vitest';
import {
  createState,
  EMPTY_REGISTRY,
  getNextRequestId,
  getToolPermission,
  prefixedToolName,
  STATE_SCHEMA_VERSION,
} from './state.js';

describe('createState', () => {
  test('returns state with correct defaults', () => {
    const state = createState();

    expect(state._schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(state.registry.plugins).toBeInstanceOf(Map);
    expect(state.registry.plugins.size).toBe(0);
    expect(state.tabMapping).toBeInstanceOf(Map);
    expect(state.tabMapping.size).toBe(0);
    expect(state.pluginPaths).toEqual([]);
    expect(state.pendingDispatches).toBeInstanceOf(Map);
    expect(state.pendingDispatches.size).toBe(0);
    expect(state.extensionWs).toBeNull();
    expect(state.outdatedPlugins).toEqual([]);
    expect(state.browserTools).toEqual([]);
    expect(state.fileWatching.entries).toEqual([]);
    expect(state.fileWatching.timers).toBeInstanceOf(Map);
    expect(state.fileWatching.timers.size).toBe(0);
    expect(state.wsSecret).toBeNull();
    expect(state.registry.toolLookup).toBeInstanceOf(Map);
    expect(state.registry.toolLookup.size).toBe(0);
    expect(state.cachedBrowserTools).toEqual([]);
    expect(state.activeDispatches).toBeInstanceOf(Map);
    expect(state.activeDispatches.size).toBe(0);
    expect(state.skipPermissions).toBe(false);
    expect(state.pluginPermissions).toEqual({});
    expect(state.pendingConfirmations).toBeInstanceOf(Map);
    expect(state.pendingConfirmations.size).toBe(0);
  });

  test('returns a fresh state on each call (no shared references)', () => {
    const a = createState();
    const b = createState();

    expect(a).not.toBe(b);
    expect(a.tabMapping).not.toBe(b.tabMapping);
    expect(a.pendingDispatches).not.toBe(b.pendingDispatches);
  });
});

describe('getNextRequestId', () => {
  test('returns a valid UUID string', () => {
    const id = getNextRequestId();

    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('returns unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => getNextRequestId()));

    expect(ids.size).toBe(100);
  });
});

describe('prefixedToolName', () => {
  test('joins plugin and tool names with underscore', () => {
    expect(prefixedToolName('slack', 'send_message')).toBe('slack_send_message');
  });

  test('works with single-word tool names', () => {
    expect(prefixedToolName('browser', 'navigate')).toBe('browser_navigate');
  });

  test('handles empty strings', () => {
    expect(prefixedToolName('', '')).toBe('_');
  });
});

describe('getToolPermission', () => {
  test('returns "auto" when skipPermissions is true', () => {
    const state = createState();
    state.skipPermissions = true;
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('auto');
  });

  test('returns "auto" when skipPermissions is true even with plugin config', () => {
    const state = createState();
    state.skipPermissions = true;
    state.pluginPermissions = { slack: { permission: 'off' } };
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('auto');
  });

  test('returns "off" for unconfigured plugin', () => {
    const state = createState();
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('off');
  });

  test('returns plugin-level permission when tool is not overridden', () => {
    const state = createState();
    state.pluginPermissions = { slack: { permission: 'ask' } };
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('ask');
  });

  test('returns per-tool override over plugin default', () => {
    const state = createState();
    state.pluginPermissions = {
      slack: { permission: 'ask', tools: { send_message: 'auto' } },
    };
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('auto');
  });

  test('returns plugin default for tool not in overrides', () => {
    const state = createState();
    state.pluginPermissions = {
      slack: { permission: 'auto', tools: { send_message: 'ask' } },
    };
    expect(getToolPermission(state, 'slack', 'read_messages')).toBe('auto');
  });

  test('returns "off" when plugin config has no permission and no tool override', () => {
    const state = createState();
    state.pluginPermissions = { slack: {} };
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('off');
  });

  test('returns "off" when plugin config has tools but not the requested one, and no plugin permission', () => {
    const state = createState();
    state.pluginPermissions = { slack: { tools: { read_messages: 'auto' } } };
    expect(getToolPermission(state, 'slack', 'send_message')).toBe('off');
  });
});

describe('EMPTY_REGISTRY', () => {
  test('registry maps are frozen instances of Map', () => {
    expect(EMPTY_REGISTRY.plugins).toBeInstanceOf(Map);
    expect(EMPTY_REGISTRY.toolLookup).toBeInstanceOf(Map);
    expect(Object.isFrozen(EMPTY_REGISTRY.plugins)).toBe(true);
    expect(Object.isFrozen(EMPTY_REGISTRY.toolLookup)).toBe(true);
  });

  test('failures array is frozen', () => {
    expect(Object.isFrozen(EMPTY_REGISTRY.failures)).toBe(true);
  });

  test('calling .set() on a frozen registry map throws TypeError', () => {
    const map = EMPTY_REGISTRY.plugins as unknown as Map<string, unknown>;
    expect(() => map.set('key', {})).toThrow(TypeError);
  });

  test('non-sentinel maps (new Map()) remain mutable', () => {
    const freshMap = new Map<string, unknown>();
    expect(() => freshMap.set('key', {})).not.toThrow();
  });
});
