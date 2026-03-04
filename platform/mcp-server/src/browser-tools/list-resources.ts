/**
 * browser_list_resources — enumerate all resources loaded by a page via CDP Page.getResourceTree.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const listResources = defineBrowserTool({
  name: 'browser_list_resources',
  description:
    'List all resources (scripts, stylesheets, documents, images, fonts, etc.) loaded by a page. ' +
    'Returns resources from the browser cache — does not re-fetch anything. ' +
    'Use the type filter "Script" to find JavaScript files for API analysis, or "Stylesheet" for CSS. ' +
    'CDP resource types: Document, Stylesheet, Image, Media, Font, Script, TextTrack, XHR, Fetch, Prefetch, ' +
    'EventSource, WebSocket, Manifest, SignedExchange, Ping, CSPViolationReport, Preflight, Other. ' +
    'Pair with browser_get_resource_content to read the source of a specific resource.',
  summary: 'List resources loaded by a page',
  icon: 'folder-tree',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID to list resources for'),
    type: z
      .string()
      .optional()
      .describe(
        "Filter by resource type (e.g. 'Script', 'Stylesheet', 'Document', 'Image', 'Font'). " +
          'Case-sensitive — must match CDP resource types exactly.',
      ),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.listResources', {
      tabId: args.tabId,
      ...(args.type !== undefined ? { type: args.type } : {}),
    }),
});

export { listResources };
