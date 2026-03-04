/**
 * browser_click_element — click an element on the page matching a CSS selector.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const clickElement = defineBrowserTool({
  name: 'browser_click_element',
  description:
    'Click an element on the page matching the given CSS selector. Dispatches a click event on the first matching ' +
    'element. Returns the tag name and trimmed text content of the clicked element. Useful for submitting forms, ' +
    'toggling buttons, and navigating.',
  summary: 'Click an element on the page',
  icon: 'mouse-pointer-click',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to interact with'),
    selector: z.string().min(1).describe('CSS selector of the element to click (e.g., "button#submit", ".nav-link")'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.clickElement', {
      tabId: args.tabId,
      selector: args.selector,
    }),
});

export { clickElement };
