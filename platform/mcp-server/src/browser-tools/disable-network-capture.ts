/**
 * browser_disable_network_capture — stop capturing network requests for a tab.
 */

import { defineBrowserTool } from './definition.js';
import { dispatchToExtension } from '../extension-protocol.js';
import { z } from 'zod';

const disableNetworkCapture = defineBrowserTool({
  name: 'browser_disable_network_capture',
  description:
    'Stop capturing network requests for a tab and release the Chrome DevTools Protocol debugger. Clears the request buffer.',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to stop capturing for'),
  }),
  handler: async (args, state) => {
    const result = await dispatchToExtension(state, 'browser.disableNetworkCapture', { tabId: args.tabId });
    state.activeNetworkCaptures.delete(args.tabId);
    return result;
  },
});

export { disableNetworkCapture };
