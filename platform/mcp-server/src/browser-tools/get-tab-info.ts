/**
 * browser_get_tab_info — get detailed information about a specific browser tab.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const getTabInfo = defineBrowserTool({
  name: 'browser_get_tab_info',
  description:
    'Get detailed information about a specific browser tab including loading status, URL, title, ' +
    'favicon URL, and whether it is active or incognito. Use browser_list_tabs to find tab IDs.',
  summary: 'Get details about a browser tab',
  icon: 'info',
  group: 'Tabs',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to get information for'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.getTabInfo', { tabId: args.tabId }),
});

export { getTabInfo };
