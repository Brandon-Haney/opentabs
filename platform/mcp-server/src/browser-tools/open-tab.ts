/**
 * browser_open_tab — opens a new browser tab with the given URL.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';
import { safeUrl } from './url-validation.js';

const openTab = defineBrowserTool({
  name: 'browser_open_tab',
  description:
    'Open a new browser tab with the specified URL. Returns the new tab ID, ' +
    'which can be used with browser_navigate_tab, browser_close_tab, and browser_execute_script.',
  summary: 'Open a new browser tab',
  icon: 'plus',
  group: 'Tabs',
  input: z.object({
    url: safeUrl.describe('URL to open in a new tab'),
  }),
  handler: async (args, state) => dispatchToExtension(state, 'browser.openTab', { url: args.url }),
});

export { openTab };
