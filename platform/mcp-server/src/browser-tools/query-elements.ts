/**
 * browser_query_elements — query all elements matching a CSS selector and return their attributes.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const DEFAULT_ATTRIBUTES = ['id', 'class', 'href', 'src', 'type', 'name', 'value', 'placeholder'];

const queryElements = defineBrowserTool({
  name: 'browser_query_elements',
  description:
    'Query all elements matching a CSS selector and return their tag names, trimmed text content (first 200 chars), ' +
    'and specified HTML attributes. Useful for understanding page structure, finding interactive elements, and ' +
    'inspecting forms. Returns up to limit elements.',
  summary: 'Query elements by CSS selector',
  icon: 'search',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to query'),
    selector: z.string().min(1).describe('CSS selector to query'),
    limit: z.number().int().positive().optional().describe('Max elements to return — defaults to 100'),
    attributes: z
      .array(z.string())
      .optional()
      .describe('Attribute names to extract — defaults to id, class, href, src, type, name, value, placeholder'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.queryElements', {
      tabId: args.tabId,
      selector: args.selector,
      limit: args.limit ?? 100,
      attributes: args.attributes ?? DEFAULT_ATTRIBUTES,
    }),
});

export { queryElements };
