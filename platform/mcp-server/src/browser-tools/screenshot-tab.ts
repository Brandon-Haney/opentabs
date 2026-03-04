/**
 * browser_screenshot_tab — capture a screenshot of a browser tab as a base64-encoded PNG.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const screenshotTab = defineBrowserTool({
  name: 'browser_screenshot_tab',
  description:
    'Capture a screenshot of the visible area of a browser tab as a base64-encoded PNG image. ' +
    'The tab is automatically focused before capture. Returns the image as a base64 string ' +
    'without the data URI prefix.',
  summary: 'Capture a screenshot of a tab',
  icon: 'camera',
  group: 'Page Inspection',
  input: z.object({
    tabId: z
      .number()
      .int()
      .positive()
      .describe('Tab ID to screenshot — the tab will be focused automatically before capture'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.screenshotTab', { tabId: args.tabId }),
});

export { screenshotTab };
