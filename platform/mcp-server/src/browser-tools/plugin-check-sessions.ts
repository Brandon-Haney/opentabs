/**
 * plugin_check_sessions — reports which plugins have a signed-in tab, and can
 * open the site for the named plugins that do not.
 *
 * Without `recover`, the report comes from the server's tab mapping and costs
 * no browser round-trip. With `recover`, each named plugin that is not ready
 * goes through the same session recovery a failing tool call uses: a
 * background tab at the plugin's last signed-in page, then a wait for its
 * adapter to report ready.
 */

import { z } from 'zod';
import { recoverSession } from '../session-recovery.js';
import type { RegisteredPlugin, ServerState } from '../state.js';
import { getMergedTabMapping } from '../state.js';
import { defineBrowserTool } from './definition.js';

type SessionStatus = 'ready' | 'not_ready' | 'no_tab' | 'needs_login' | 'recovered';

interface SessionReport {
  plugin: string;
  site: string;
  status: SessionStatus;
  tabs: number;
  /** The tab to use: the ready tab, or the one session recovery opened. */
  tabId?: number;
  /**
   * Set only when session recovery opened `tabId` (in this call or a recent
   * failed one), so a caller can close what recovery opened without touching
   * the user's own tabs.
   */
  openedTabId?: number;
  url?: string;
  note?: string;
}

const currentStatus = (state: ServerState, plugin: RegisteredPlugin): SessionReport => {
  const mapping = getMergedTabMapping(state).get(plugin.name);
  const tabs = mapping?.tabs ?? [];
  const base = { plugin: plugin.name, site: plugin.displayName, tabs: tabs.length };

  const signInWait = state.sessionRecovery.needsLogin.get(plugin.name)?.outcome;
  if (signInWait) {
    return {
      ...base,
      status: 'needs_login',
      url: signInWait.url,
      ...(signInWait.tabId !== undefined && { tabId: signInWait.tabId, openedTabId: signInWait.tabId }),
      note: `A recent call found ${plugin.displayName} signed out: ${signInWait.reason}.`,
    };
  }

  const readyTab = tabs.find(tab => tab.ready);
  if (readyTab) return { ...base, status: 'ready', tabId: readyTab.tabId };
  return { ...base, status: tabs.length > 0 ? 'not_ready' : 'no_tab' };
};

const recover = async (state: ServerState, plugin: RegisteredPlugin): Promise<SessionReport> => {
  const before = currentStatus(state, plugin);
  if (before.status === 'ready') return before;

  const outcome = await recoverSession(state, plugin);
  const base = { plugin: plugin.name, site: plugin.displayName, tabs: before.tabs };
  switch (outcome.kind) {
    case 'recovered':
      return {
        ...base,
        tabs: before.tabs + 1,
        status: 'recovered',
        tabId: outcome.tabId,
        openedTabId: outcome.tabId,
        url: outcome.url,
      };
    case 'needs_login':
      return {
        ...base,
        status: 'needs_login',
        url: outcome.url,
        ...(outcome.tabId !== undefined && { tabId: outcome.tabId, openedTabId: outcome.tabId }),
        note: `Sign in at ${outcome.url}; ${outcome.reason}.`,
      };
    case 'no_url':
      return {
        ...base,
        status: before.status,
        note: `No known address to open: ${plugin.displayName} has not been seen signed in and has no homepage. Open it in the browser once.`,
      };
  }
};

const pluginCheckSessions = defineBrowserTool({
  name: 'plugin_check_sessions',
  description:
    'Check which plugins have a signed-in browser tab. Each plugin reports a status: ready (a tab with a ready ' +
    'adapter), not_ready (tabs open but none ready, often a sign-in page), no_tab, needs_login (a recent call found ' +
    'the site signed out and an interactive sign-in is needed; includes the url), or recovered. "ready" reflects the ' +
    "adapter's own check and does not prove the server session is still valid; with the sessionRecovery setting on, " +
    'a plugin tool call that meets an expired session opens the site and retries once. With recover: true, each plugin named in plugins ' +
    'that is not ready is opened in a background tab at its last signed-in page and given up to 60 seconds to sign ' +
    'in through single sign-on. openedTabId appears only on tabs session recovery opened; close those (never a ' +
    "plain tabId, which may be the user's own tab) to clean up. Use it at the start of an unattended run to learn " +
    'which plugins are usable.',
  summary: 'Check which plugins are signed in',
  icon: 'shield-check',
  group: 'Plugins',
  input: z.object({
    plugins: z
      .array(z.string())
      .optional()
      .describe('Plugin names to check. When omitted, reports every installed plugin.'),
    recover: z
      .boolean()
      .optional()
      .describe(
        'Open a background tab for each named plugin that is not ready and wait for it to sign in. Requires plugins.',
      ),
  }),
  handler: async ({ plugins, recover: shouldRecover }, state) => {
    if (shouldRecover && (plugins === undefined || plugins.length === 0)) {
      return { error: 'recover needs the plugins to open; name them in plugins.' };
    }

    const unknown = (plugins ?? []).filter(name => !state.registry.plugins.has(name));
    if (unknown.length > 0) {
      return {
        error: `Unknown plugin(s): ${unknown.join(', ')}. Installed plugins: ${[...state.registry.plugins.keys()].join(', ') || '(none)'}`,
      };
    }

    const selected =
      plugins === undefined
        ? [...state.registry.plugins.values()]
        : plugins.map(name => state.registry.plugins.get(name) as RegisteredPlugin);

    return Promise.all(
      selected.map(plugin => (shouldRecover ? recover(state, plugin) : Promise.resolve(currentStatus(state, plugin)))),
    );
  },
});

export { pluginCheckSessions };
