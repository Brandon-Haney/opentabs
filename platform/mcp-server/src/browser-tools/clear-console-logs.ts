/**
 * browser_clear_console_logs — clear the console log buffer for a browser tab.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const clearConsoleLogs = defineBrowserTool({
  name: 'browser_clear_console_logs',
  description: 'Clear the console log buffer for a browser tab without disabling capture.',
  summary: 'Clear captured console logs for a tab',
  icon: 'eraser',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to clear console logs for'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.clearConsoleLogs', { tabId: args.tabId }),
});

export { clearConsoleLogs };
