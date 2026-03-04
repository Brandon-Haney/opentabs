/**
 * browser_get_console_logs — get console log messages from a browser tab.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const getConsoleLogs = defineBrowserTool({
  name: 'browser_get_console_logs',
  description:
    'Get console log messages from a browser tab. Requires browser_enable_network_capture to be active on the tab ' +
    '(the debugger captures both network requests and console output). Filter by level to see only errors, warnings, etc.',
  summary: 'Get console log messages from a tab',
  icon: 'terminal',
  group: 'Page Inspection',
  input: z.object({
    tabId: z
      .number()
      .int()
      .positive()
      .describe(
        'Tab ID to get console logs from — network capture must be enabled first via browser_enable_network_capture',
      ),
    clear: z.boolean().optional().describe('Clear the log buffer after reading — defaults to false'),
    level: z
      .enum(['all', 'log', 'warn', 'error', 'info', 'debug'])
      .optional()
      .describe('Filter by log level — defaults to all'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.getConsoleLogs', {
      tabId: args.tabId,
      ...(args.clear !== undefined ? { clear: args.clear } : {}),
      ...(args.level !== undefined ? { level: args.level } : {}),
    }),
});

export { getConsoleLogs };
