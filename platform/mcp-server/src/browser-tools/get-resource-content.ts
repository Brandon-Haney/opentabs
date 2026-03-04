/**
 * browser_get_resource_content — read the content of a specific resource by URL via CDP Page.getResourceContent.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const getResourceContent = defineBrowserTool({
  name: 'browser_get_resource_content',
  description:
    'Read the content of a specific resource (JS, CSS, HTML, etc.) loaded by a page. ' +
    'Returns content from the browser cache — does not re-fetch the resource. ' +
    'Use browser_list_resources first to find the resource URL you want to read. ' +
    'Useful for reading minified JavaScript to understand API patterns, endpoints, data models, and authentication. ' +
    'Text content is returned as a string; binary resources (images, fonts, wasm) are returned as base64.',
  summary: 'Read a page resource from cache',
  icon: 'file-code',
  group: 'Page Inspection',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID that loaded the resource'),
    url: z.string().describe('The full URL of the resource to read (from browser_list_resources output)'),
    maxLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum content length to return (default: 500000). Text content exceeding this is truncated.'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.getResourceContent', {
      tabId: args.tabId,
      url: args.url,
      ...(args.maxLength !== undefined ? { maxLength: args.maxLength } : {}),
    }),
});

export { getResourceContent };
