/**
 * browser_wait_for_element — wait for an element matching a CSS selector to appear in the DOM.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const waitForElement = defineBrowserTool({
  name: 'browser_wait_for_element',
  description:
    'Wait for an element matching the CSS selector to appear in the DOM. Polls the page until the element is found ' +
    'or timeout expires. For SPAs where content loads asynchronously. Set visible=true to also require the element ' +
    'to be visible (not hidden by CSS).',
  summary: 'Wait for an element to appear',
  icon: 'clock',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to wait on'),
    selector: z.string().min(1).describe('CSS selector to wait for'),
    timeout: z.number().int().positive().optional().describe('Max wait time in ms — defaults to 10000'),
    visible: z
      .boolean()
      .optional()
      .describe('Also require element to be visible, not display:none or visibility:hidden — defaults to false'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.waitForElement', {
      tabId: args.tabId,
      selector: args.selector,
      timeout: args.timeout ?? 10000,
      visible: args.visible ?? false,
    }),
});

export { waitForElement };
