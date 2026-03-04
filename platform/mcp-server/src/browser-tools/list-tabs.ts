/**
 * browser_list_tabs — lists all open browser tabs.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const listTabs = defineBrowserTool({
  name: 'browser_list_tabs',
  description:
    'List all open browser tabs. Returns tab ID, title, URL, and active status for each tab. ' +
    'Use the returned tab IDs with browser_close_tab, browser_navigate_tab, and browser_execute_script. ' +
    'Note: Returns ALL open tabs including potentially sensitive ones (banking, email, etc.). Tab URLs and titles may contain private information. Do not share tab information with plugin tools unless the user explicitly requests it.',
  summary: 'List all open browser tabs',
  icon: 'layout-list',
  group: 'Tabs',
  input: z.object({}),
  handler: async (_args, state) => dispatchToExtension(state, 'browser.listTabs', {}),
});

export { listTabs };
