/**
 * browser_scroll — scroll the page or a specific container by direction, to a position,
 * or to bring an element into view.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const scroll = defineBrowserTool({
  name: 'browser_scroll',
  description:
    'Scroll the page or a scrollable container. Three modes: (1) provide a CSS selector to scroll that element ' +
    'into view (centered), (2) provide a direction (up/down/left/right) with optional distance in pixels to scroll ' +
    'relatively (defaults to one viewport height/width), (3) provide a position {x, y} to scroll to absolutely. ' +
    'If none are provided, returns the current scroll position without scrolling. Use the optional container parameter ' +
    'to scroll within a specific scrollable element instead of the page. Returns scroll position, total scroll size, ' +
    'and viewport size so you know how much more content exists.',
  summary: 'Scroll the page or a container',
  icon: 'arrow-down-up',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to interact with'),
    selector: z
      .string()
      .min(1)
      .optional()
      .describe('CSS selector of element to scroll into view (uses scrollIntoView with block: "center")'),
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .optional()
      .describe('Direction to scroll relatively. Defaults to one viewport height (up/down) or width (left/right).'),
    distance: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Distance in pixels for relative scrolling. Defaults to viewport height (up/down) or width (left/right).',
      ),
    position: z
      .object({
        x: z.number().optional().describe('Absolute horizontal scroll position in pixels'),
        y: z.number().optional().describe('Absolute vertical scroll position in pixels'),
      })
      .optional()
      .describe('Absolute scroll position to scroll to'),
    container: z
      .string()
      .min(1)
      .optional()
      .describe('CSS selector of a scrollable container to scroll within instead of the page'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.scroll', {
      tabId: args.tabId,
      ...(args.selector !== undefined ? { selector: args.selector } : {}),
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.distance !== undefined ? { distance: args.distance } : {}),
      ...(args.position !== undefined ? { position: args.position } : {}),
      ...(args.container !== undefined ? { container: args.container } : {}),
    }),
});

export { scroll };
