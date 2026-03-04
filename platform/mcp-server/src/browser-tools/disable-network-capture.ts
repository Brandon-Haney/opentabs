/**
 * browser_disable_network_capture — stop capturing network requests for a tab.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const disableNetworkCapture = defineBrowserTool({
  name: 'browser_disable_network_capture',
  description:
    'Stop capturing network requests for a tab and release the Chrome DevTools Protocol debugger. Clears the request buffer.',
  summary: 'Stop capturing network traffic',
  icon: 'wifi-off',
  group: 'Network',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to stop capturing for'),
  }),
  handler: async (args, state) => {
    try {
      return await dispatchToExtension(state, 'browser.disableNetworkCapture', { tabId: args.tabId });
    } finally {
      state.activeNetworkCaptures.delete(args.tabId);
    }
  },
});

export { disableNetworkCapture };
