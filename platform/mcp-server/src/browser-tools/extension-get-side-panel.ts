/**
 * extension_get_side_panel — returns the side panel's current React state and rendered HTML.
 * If the side panel is not open, returns { open: false }.
 */

import { defineBrowserTool } from './definition.js';
import { dispatchToExtension } from '../extension-protocol.js';
import { z } from 'zod';

const extensionGetSidePanel = defineBrowserTool({
  name: 'extension_get_side_panel',
  description:
    'Get the side panel state and rendered HTML. ' +
    'Returns the React state (connected, loading, plugins) and the root innerHTML. ' +
    'If the side panel is not open, returns { open: false }.',
  input: z.object({}),
  handler: async (_args, state) => dispatchToExtension(state, 'extension.getSidePanel', {}),
});

export { extensionGetSidePanel };
