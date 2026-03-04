/**
 * browser_navigate_tab — navigates an existing tab to a new URL.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';
import { safeUrl } from './url-validation.js';

const navigateTab = defineBrowserTool({
  name: 'browser_navigate_tab',
  description: 'Navigate an existing browser tab to a new URL. Use browser_list_tabs to find tab IDs.',
  summary: 'Navigate a tab to a new URL',
  icon: 'compass',
  group: 'Tabs',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to navigate'),
    url: safeUrl.describe('URL to navigate to'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.navigateTab', { tabId: args.tabId, url: args.url }),
});

export { navigateTab };
