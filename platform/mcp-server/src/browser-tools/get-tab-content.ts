/**
 * browser_get_tab_content — extract text content from a web page or specific element.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const getTabContent = defineBrowserTool({
  name: 'browser_get_tab_content',
  description:
    'Extract the visible text content of a web page or a specific element. Returns the page title, ' +
    'current URL, and text content. Use the selector parameter to scope extraction to a specific section. ' +
    'Useful for understanding page content without writing custom JavaScript.',
  summary: 'Extract visible text from a page',
  icon: 'file-text',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to extract content from'),
    selector: z.string().optional().describe('CSS selector to scope extraction — defaults to body'),
    maxLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum characters to return — defaults to 50000, increase for long pages'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.getTabContent', {
      tabId: args.tabId,
      selector: args.selector ?? 'body',
      maxLength: args.maxLength ?? 50000,
    }),
});

export { getTabContent };
