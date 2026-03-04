/**
 * extension_get_state — returns comprehensive internal state of the Chrome extension.
 * Includes WebSocket connection status, all plugins with tab states, active network
 * captures, and offscreen document status.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const extensionGetState = defineBrowserTool({
  name: 'extension_get_state',
  description:
    'Get the complete internal state of the OpenTabs Chrome extension. ' +
    'Returns WebSocket connection status, all registered plugins with their tab states, ' +
    'active network captures, and offscreen document status. ' +
    'Use this tool to quickly understand the overall health of the extension without opening DevTools.',
  summary: 'Get extension internal state',
  icon: 'settings',
  group: 'Extension',
  input: z.object({}),
  handler: async (_args, state) => dispatchToExtension(state, 'extension.getState', {}),
});

export { extensionGetState };
