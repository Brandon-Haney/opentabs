import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentPageContent } from '../page-cache.js';

export const readCurrentPage = defineTool({
  name: 'read_current_page',
  displayName: 'Read Current Page',
  description:
    'Read the content of the OneNote page currently open in this tab. Returns the page title, its date/time line, and the page text. Works without a Graph token (including on SharePoint/OneDrive-hosted notebooks) by reading the viewer\'s local page cache. Pass format "html" to also get the raw page HTML.',
  summary: 'Read the currently open OneNote page',
  icon: 'file-text',
  group: 'Pages',
  input: z.object({
    format: z
      .enum(['text', 'html'])
      .optional()
      .describe('Output format: "text" (default) returns plain text; "html" also includes the raw page HTML.'),
  }),
  output: z.object({
    title: z.string().describe('Page title'),
    dateTime: z.string().describe('The date/time line shown under the title (empty if absent)'),
    text: z.string().describe('Plain-text page content'),
    html: z.string().optional().describe('Raw page HTML (only when format is "html")'),
  }),
  handle: async params => {
    const content = getCurrentPageContent(params.format ?? 'text');
    if (!content) {
      throw ToolError.notFound(
        'No cached OneNote page found in this tab. Open a page in the notebook and wait for it to finish loading, then try again.',
      );
    }
    return content;
  },
});
