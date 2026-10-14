import { beforeEach, describe, expect, test, vi } from 'vitest';
import { recoverSession } from '../session-recovery.js';
import type { RegisteredPlugin, ServerState, TabMapping } from '../state.js';
import { createState } from '../state.js';
import { pluginCheckSessions } from './plugin-check-sessions.js';

vi.mock('../session-recovery.js', () => ({ recoverSession: vi.fn() }));

const plugin = (name: string, displayName: string): RegisteredPlugin =>
  ({ name, displayName, urlPatterns: [], excludePatterns: [], tools: [] }) as unknown as RegisteredPlugin;

/** A state with the given plugins installed and the given tab mapping reported by one connection. */
const stateWith = (plugins: RegisteredPlugin[], mapping: Record<string, TabMapping>): ServerState => {
  const state = createState();
  state.registry = {
    plugins: new Map(plugins.map(p => [p.name, p])),
    toolLookup: new Map(),
    failures: [],
  } as unknown as ServerState['registry'];
  state.extensionConnections.set('conn', {
    ws: { send() {}, close() {} },
    connectionId: 'conn',
    profileLabel: 'A',
    tabMapping: new Map(Object.entries(mapping)),
    activeNetworkCaptures: new Set(),
  });
  return state;
};

const TEAMS = plugin('teams', 'Microsoft Teams');
const JIRA = plugin('jira', 'Jira');
const FUSION = plugin('oracle-fusion', 'Oracle Fusion');

const READY_TEAMS: TabMapping = {
  state: 'ready',
  tabs: [{ tabId: 11, url: 'https://teams.cloud.microsoft/', title: '', ready: true }],
};

beforeEach(() => {
  vi.mocked(recoverSession).mockReset();
});

describe('plugin_check_sessions', () => {
  test('reports each plugin from the tab mapping without opening anything', async () => {
    const state = stateWith([TEAMS, JIRA], { teams: READY_TEAMS });

    const reports = await pluginCheckSessions.handler({ plugins: undefined, recover: undefined }, state);

    expect(reports).toEqual([
      { plugin: 'teams', site: 'Microsoft Teams', tabs: 1, status: 'ready', tabId: 11 },
      { plugin: 'jira', site: 'Jira', tabs: 0, status: 'no_tab' },
    ]);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test('marks only the tabs recovery opened, never a ready tab the user already had', async () => {
    const state = stateWith([TEAMS, JIRA, FUSION], { teams: READY_TEAMS });
    vi.mocked(recoverSession).mockImplementation(async (_state, target) =>
      target.name === 'jira'
        ? { kind: 'recovered', tabId: 21, url: 'https://gpcprod.atlassian.net/' }
        : { kind: 'needs_login', tabId: 31, url: 'https://x.oraclecloud.com/fscmUI/', reason: 'it timed out' },
    );

    const reports = await pluginCheckSessions.handler(
      { plugins: ['teams', 'jira', 'oracle-fusion'], recover: true },
      state,
    );

    expect(reports).toEqual([
      { plugin: 'teams', site: 'Microsoft Teams', tabs: 1, status: 'ready', tabId: 11 },
      {
        plugin: 'jira',
        site: 'Jira',
        tabs: 1,
        status: 'recovered',
        tabId: 21,
        openedTabId: 21,
        url: 'https://gpcprod.atlassian.net/',
      },
      expect.objectContaining({ plugin: 'oracle-fusion', status: 'needs_login', tabId: 31, openedTabId: 31 }),
    ]);
    expect(recoverSession).toHaveBeenCalledTimes(2);
  });

  test('marks the tab a recent failed recovery left open', async () => {
    const state = stateWith([FUSION], {});
    state.sessionRecovery.needsLogin.set('oracle-fusion', {
      at: Date.now(),
      outcome: { kind: 'needs_login', tabId: 31, url: 'https://x.oraclecloud.com/fscmUI/', reason: 'it timed out' },
    });

    const [report] = (await pluginCheckSessions.handler({ plugins: ['oracle-fusion'] }, state)) as unknown[];

    expect(report).toMatchObject({ status: 'needs_login', tabId: 31, openedTabId: 31 });
  });

  test('requires the plugins to recover, and rejects unknown names', async () => {
    const state = stateWith([TEAMS], {});

    expect(await pluginCheckSessions.handler({ recover: true }, state)).toEqual({
      error: 'recover needs the plugins to open; name them in plugins.',
    });
    expect(await pluginCheckSessions.handler({ plugins: ['nope'] }, state)).toMatchObject({
      error: expect.stringContaining('Unknown plugin(s): nope'),
    });
  });
});
