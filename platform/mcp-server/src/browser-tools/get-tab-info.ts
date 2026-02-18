/**
 * browser_get_tab_info — get detailed information about a specific browser tab.
 */

import { defineBrowserTool } from './definition.js';
import { dispatchToExtension } from '../extension-protocol.js';
import { z } from 'zod';

const getTabInfo = defineBrowserTool({
  name: 'browser_get_tab_info',
  description:
    'Get detailed information about a specific browser tab including loading status, URL, title, ' +
    'favicon URL, and whether it is active or incognito. Use browser_list_tabs to find tab IDs.',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to get information for'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.getTabInfo', { tabId: args.tabId }),
});

export { getTabInfo };
