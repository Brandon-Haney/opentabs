/**
 * extension_force_reconnect — forces the WebSocket to disconnect and reconnect
 * without reloading the entire extension. Useful for diagnosing connection
 * issues and testing reconnection behavior.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const extensionForceReconnect = defineBrowserTool({
  name: 'extension_force_reconnect',
  description:
    'Force the Chrome extension to disconnect its WebSocket and reconnect to the MCP server. ' +
    'This tears down the current connection, resets the backoff timer, and initiates an immediate ' +
    'reconnection attempt. The normal sync.full flow resumes after reconnection. ' +
    'Use this to recover from stale connections without a full extension reload.',
  summary: 'Force WebSocket reconnection',
  icon: 'refresh-cw',
  group: 'Extension',
  input: z.object({}),
  handler: async (_args, state) => dispatchToExtension(state, 'extension.forceReconnect', {}),
});

export { extensionForceReconnect };
