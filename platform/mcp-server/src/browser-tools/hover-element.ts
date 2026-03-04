/**
 * browser_hover_element — dispatch mouse hover events on a page element to trigger
 * dropdown menus, tooltips, and other hover-dependent UI.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const hoverElement = defineBrowserTool({
  name: 'browser_hover_element',
  description:
    'Hover over an element to trigger hover events (mouseenter, mouseover, pointermove, etc.). ' +
    'This reveals dropdown menus, tooltips, and hidden UI that only appears on mouseover. ' +
    'Dispatches a realistic pointer/mouse event sequence matching real browser behavior. ' +
    'Suggest taking a screenshot after hovering to see the result.',
  summary: 'Hover over an element on the page',
  icon: 'hand',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to interact with'),
    selector: z.string().min(1).describe('CSS selector of the element to hover over'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.hoverElement', {
      tabId: args.tabId,
      selector: args.selector,
    }),
});

export { hoverElement };
