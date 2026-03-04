/**
 * plugin_list_tabs — lists all matching tabs for a plugin with readiness status.
 *
 * Reads directly from the server's tabMapping (populated by tab.syncAll and
 * tab.stateChanged events from the extension) — no extension dispatch needed.
 */

import { z } from 'zod';
import { defineBrowserTool } from './definition.js';

const pluginListTabs = defineBrowserTool({
  name: 'plugin_list_tabs',
  description:
    "List open browser tabs that match a plugin's URL patterns. Returns tab IDs, URLs, titles, and readiness " +
    'status for each matching tab. Use this to discover which tabs are available before targeting a specific one ' +
    'with the tabId parameter on plugin tools. When called without a plugin argument, returns tabs for all plugins.',
  summary: 'List tabs matching a plugin',
  icon: 'list',
  group: 'Plugins',
  input: z.object({
    plugin: z
      .string()
      .optional()
      .describe(
        'Plugin name. When provided, returns tabs for this plugin only. When omitted, returns tabs for all plugins.',
      ),
  }),
  handler: (_args, state) => {
    const { plugin } = _args;

    if (plugin !== undefined) {
      const registered = state.registry.plugins.get(plugin);
      if (!registered) {
        return Promise.resolve({
          error: `Plugin "${plugin}" not found. Available plugins: ${[...state.registry.plugins.keys()].join(', ') || '(none)'}`,
        });
      }

      const mapping = state.tabMapping.get(plugin);
      return Promise.resolve([
        {
          plugin,
          displayName: registered.displayName,
          state: mapping?.state ?? 'closed',
          tabs: mapping?.tabs ?? [],
        },
      ]);
    }

    const results: Array<{
      plugin: string;
      displayName: string;
      state: string;
      tabs: Array<{ tabId: number; url: string; title: string; ready: boolean }>;
    }> = [];

    for (const registered of state.registry.plugins.values()) {
      const mapping = state.tabMapping.get(registered.name);
      results.push({
        plugin: registered.name,
        displayName: registered.displayName,
        state: mapping?.state ?? 'closed',
        tabs: mapping?.tabs ?? [],
      });
    }

    return Promise.resolve(results);
  },
});

export { pluginListTabs };
