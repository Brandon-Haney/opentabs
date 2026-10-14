import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { dispatchToExtension } from './extension-protocol.js';
import {
  classifySessionFailure,
  formatNeedsLogin,
  markSessionWorking,
  NEEDS_LOGIN_COOLDOWN_MS,
  RECOVERY_READY_TIMEOUT_MS,
  recoverSession,
  recoveryUrl,
  rememberReadyTab,
} from './session-recovery.js';
import type { ExtensionConnection, RegisteredPlugin, ServerState } from './state.js';
import { createState } from './state.js';

const configDir = vi.hoisted(() => ({ path: '' }));
vi.mock('./config.js', () => ({ getConfigDir: () => configDir.path }));
vi.mock('./extension-protocol.js', () => ({ dispatchToExtension: vi.fn() }));
vi.mock('./logger.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const plugin = (overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin =>
  ({
    name: 'servicenow',
    displayName: 'ServiceNow',
    urlPatterns: ['*://*.service-now.com/*'],
    excludePatterns: [],
    tools: [],
    ...overrides,
  }) as RegisteredPlugin;

const connect = (state: ServerState): ExtensionConnection => {
  const conn: ExtensionConnection = {
    ws: { send() {}, close() {} },
    connectionId: 'conn',
    profileLabel: 'A',
    tabMapping: new Map(),
    activeNetworkCaptures: new Set(),
  };
  state.extensionConnections.set('conn', conn);
  return conn;
};

/** Make the extension open tab `tabId`, and report it ready when `ready` is true. */
const openTabAs = (conn: ExtensionConnection, tabId: number, ready: boolean): void => {
  vi.mocked(dispatchToExtension).mockImplementation(async (_state, _method, params) => {
    conn.tabMapping.set('servicenow', {
      state: ready ? 'ready' : 'unavailable',
      tabs: [{ tabId, url: String((params as { url: string }).url), title: '', ready }],
    });
    return { id: tabId };
  });
};

beforeEach(() => {
  configDir.path = mkdtempSync(join(tmpdir(), 'session-recovery-'));
  vi.mocked(dispatchToExtension).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(configDir.path, { recursive: true, force: true });
});

describe('classifySessionFailure', () => {
  const enabled = (): ServerState => {
    const state = createState();
    state.sessionRecovery.enabled = true;
    return state;
  };
  const NO_TAB = { code: -32001, message: 'No matching tab for plugin "x" (state: closed)' };

  test('recognizes a missing tab, an unready adapter and a rejected session', () => {
    expect(classifySessionFailure(enabled(), NO_TAB, false)).toBe('no_tab');
    expect(classifySessionFailure(enabled(), { code: -32002, message: 'Adapter "x" not ready' }, false)).toBe(
      'not_ready',
    );
    expect(
      classifySessionFailure(
        enabled(),
        { code: -32603, message: 'HTTP 401', data: { code: 'AUTH_ERROR', category: 'auth' } },
        false,
      ),
    ).toBe('auth');
  });

  test('leaves alone a tab that closed mid-call, other errors, and targeted calls', () => {
    const state = enabled();
    expect(classifySessionFailure(state, { code: -32001, message: 'Tab closed during tool dispatch' }, false)).toBe(
      undefined,
    );
    expect(
      classifySessionFailure(state, { code: -32603, message: 'boom', data: { category: 'internal' } }, false),
    ).toBeUndefined();
    expect(classifySessionFailure(state, { code: -32002, message: 'Adapter "x" not ready' }, true)).toBeUndefined();
  });

  test('recovers nothing unless the sessionRecovery setting is on', () => {
    expect(classifySessionFailure(createState(), NO_TAB, false)).toBeUndefined();
  });
});

describe('recovery URL', () => {
  /** A state whose registry holds the given plugins. */
  const stateWith = (...plugins: RegisteredPlugin[]): ServerState => {
    const state = createState();
    state.registry = {
      plugins: new Map(plugins.map(p => [p.name, p])),
      toolLookup: new Map(),
      failures: [],
    } as unknown as ServerState['registry'];
    return state;
  };

  const readyTab = (url: string) => ({ state: 'ready' as const, tabs: [{ tabId: 2, url, title: '', ready: true }] });

  test('remembers the origin of a ready tab, not the record it shows, and saves it', async () => {
    vi.useFakeTimers();
    const state = stateWith(plugin());
    rememberReadyTab(state, 'servicenow', {
      state: 'ready',
      tabs: [
        { tabId: 1, url: 'https://gpc.service-now.com/login.do', title: '', ready: false },
        {
          tabId: 2,
          url: 'https://gpc.service-now.com/now/nav/ui/classic/incident.do?sys_id=1#x',
          title: '',
          ready: true,
        },
      ],
    });

    expect(await recoveryUrl(state, plugin())).toBe('https://gpc.service-now.com/');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(join(configDir.path, 'session-urls.json'), 'utf-8'))).toEqual({
        servicenow: 'https://gpc.service-now.com/',
      }),
    );
  });

  test('keeps the fixed path the URL pattern requires', async () => {
    const fusion = plugin({ name: 'oracle-fusion', urlPatterns: ['*://*.oraclecloud.com/fscmUI/*'] });
    const state = stateWith(fusion);

    rememberReadyTab(
      state,
      'oracle-fusion',
      readyTab('https://x.fa.ocs.oraclecloud.com/fscmUI/faces/FuseWelcome?_adf=1'),
    );

    expect(await recoveryUrl(state, fusion)).toBe('https://x.fa.ocs.oraclecloud.com/fscmUI/');
  });

  test('ignores a plugin the registry does not hold', async () => {
    const state = stateWith();

    rememberReadyTab(state, 'servicenow', readyTab('https://gpc.service-now.com/'));

    expect(state.sessionRecovery.urls.size).toBe(0);
  });

  test('reads the saved page after a restart, and falls back to the homepage', async () => {
    writeFileSync(
      join(configDir.path, 'session-urls.json'),
      JSON.stringify({ servicenow: 'https://a.service-now.com/' }),
    );

    expect(await recoveryUrl(createState(), plugin())).toBe('https://a.service-now.com/');
    expect(
      await recoveryUrl(createState(), plugin({ name: 'teams', homepage: 'https://teams.microsoft.com/v2/?x' })),
    ).toBe('https://teams.microsoft.com/v2/');
    expect(await recoveryUrl(createState(), plugin({ name: 'jira' }))).toBeUndefined();
  });
});

describe('recoverSession', () => {
  test('opens a background tab at the remembered page and waits for it to be ready', async () => {
    const state = createState();
    const conn = connect(state);
    state.sessionRecovery.urls.set('servicenow', 'https://gpc.service-now.com/now/nav/ui/home');
    openTabAs(conn, 7, true);

    const outcome = await recoverSession(state, plugin());

    expect(outcome).toEqual({ kind: 'recovered', tabId: 7, url: 'https://gpc.service-now.com/now/nav/ui/home' });
    expect(dispatchToExtension).toHaveBeenCalledWith(state, 'browser.openTab', {
      url: 'https://gpc.service-now.com/now/nav/ui/home',
      active: false,
    });
  });

  test('shares one recovery between concurrent calls', async () => {
    const state = createState();
    const conn = connect(state);
    state.sessionRecovery.urls.set('servicenow', 'https://gpc.service-now.com/');
    openTabAs(conn, 7, true);

    const [first, second] = await Promise.all([recoverSession(state, plugin()), recoverSession(state, plugin())]);

    expect(first).toEqual(second);
    expect(dispatchToExtension).toHaveBeenCalledTimes(1);
  });

  test('reports needs_login when the tab never becomes ready, then holds off opening another', async () => {
    const state = createState();
    const conn = connect(state);
    state.sessionRecovery.urls.set('servicenow', 'https://gpc.service-now.com/');
    // Read the saved URLs before the clock is faked: the file read is real I/O.
    await recoveryUrl(state, plugin());
    vi.useFakeTimers();
    openTabAs(conn, 7, false);

    const pending = recoverSession(state, plugin());
    await vi.advanceTimersByTimeAsync(RECOVERY_READY_TIMEOUT_MS + 1_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ kind: 'needs_login', url: 'https://gpc.service-now.com/', tabId: 7 });
    expect(await recoverSession(state, plugin())).toEqual(outcome);
    expect(dispatchToExtension).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + NEEDS_LOGIN_COOLDOWN_MS);
    openTabAs(conn, 8, true);
    expect(await recoverSession(state, plugin())).toMatchObject({ kind: 'recovered', tabId: 8 });
  });

  test('a successful call ends the cooldown', async () => {
    const state = createState();
    connect(state);
    state.sessionRecovery.needsLogin.set('servicenow', {
      at: Date.now(),
      outcome: { kind: 'needs_login', url: 'https://gpc.service-now.com/', reason: 'r' },
    });

    markSessionWorking(state, 'servicenow');

    expect(state.sessionRecovery.needsLogin.has('servicenow')).toBe(false);
  });

  test('reports no_url for a plugin never seen signed in and without a homepage', async () => {
    expect(await recoverSession(createState(), plugin({ name: 'jira' }))).toEqual({ kind: 'no_url' });
    expect(dispatchToExtension).not.toHaveBeenCalled();
  });
});

describe('formatNeedsLogin', () => {
  test('names the site, the URL and the open tab, with a machine-readable block', () => {
    const text = formatNeedsLogin(
      plugin(),
      { kind: 'needs_login', url: 'https://gpc.service-now.com/', tabId: 7, reason: 'it timed out' },
      'HTTP 401 User is not authenticated',
    );

    expect(text).toContain('[ERROR code=NEEDS_LOGIN category=auth retryable=false] ServiceNow is not signed in.');
    expect(text).toContain('sign in at https://gpc.service-now.com/ (tab 7 is open there)');
    expect(text).toContain('Original error: HTTP 401 User is not authenticated');
    const block = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
    expect(block).toEqual({
      code: 'NEEDS_LOGIN',
      category: 'auth',
      retryable: false,
      plugin: 'servicenow',
      site: 'ServiceNow',
      url: 'https://gpc.service-now.com/',
      tabId: 7,
    });
  });
});
