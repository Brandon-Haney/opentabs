/**
 * extension_reload — sends a reload signal to the Chrome extension.
 * The extension will briefly disconnect and automatically reconnect.
 *
 * Uses fire-and-forget: the extension calls chrome.runtime.reload() which
 * kills the connection before a response can arrive, so awaiting a dispatch
 * would always hit the timeout. Instead we send the message directly on the
 * WebSocket (matching the POST /extension/reload HTTP endpoint pattern).
 */

import { defineBrowserTool } from './definition.js';
import { z } from 'zod';

const reloadExtension = defineBrowserTool({
  name: 'extension_reload',
  description:
    'Reload the OpenTabs Chrome extension. The extension will briefly disconnect and automatically reconnect.',
  input: z.object({}),
  handler: (_args, state) => {
    if (!state.extensionWs) {
      return Promise.resolve({ ok: false, error: 'Extension not connected' });
    }
    try {
      state.extensionWs.send(JSON.stringify({ jsonrpc: '2.0', method: 'extension.reload' }));
    } catch {
      return Promise.resolve({
        ok: false,
        error: 'Failed to send reload signal — extension may be disconnecting',
      });
    }
    return Promise.resolve({ ok: true, message: 'Reload signal sent to extension' });
  },
});

export { reloadExtension };
