/**
 * browser_focus_tab — focus a browser tab by making it the active tab.
 */

import { defineBrowserTool } from './definition.js';
import { dispatchToExtension } from '../extension-protocol.js';
import { z } from 'zod';

const focusTab = defineBrowserTool({
  name: 'browser_focus_tab',
  description:
    'Focus a browser tab by making it the active tab in its window and bringing the window to the foreground. ' +
    'Useful for bringing a tab to the foreground for visual inspection. Use browser_list_tabs to find tab IDs.',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to focus'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.focusTab', { tabId: args.tabId }),
});

export { focusTab };
