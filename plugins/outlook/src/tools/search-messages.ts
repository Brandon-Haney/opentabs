import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';
import { nextPageToken, pageQuery } from '../search-paging.js';
import { MESSAGE_SUMMARY_FIELDS, mapMessageSummary, messageSummarySchema, type RawMessage } from './schemas.js';

export const searchMessages = defineTool({
  name: 'search_messages',
  displayName: 'Search Messages',
  description:
    'Search emails using a keyword query (KQL). Searches subject, body, and sender. Examples: "budget report", "from:jane@example.com", "subject:quarterly review", "hasAttachments:true". Results may continue past one page: pass next_page_token back, with the same query, to get more.',
  summary: 'Search emails by keyword',
  icon: 'search',
  group: 'Messages',
  input: z.object({
    query: z.string().describe('Search query (KQL syntax)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results per page (default 10, max 50)'),
    next_page_token: z
      .string()
      .optional()
      .describe('next_page_token from the previous page of this same search, to get the page after it'),
  }),
  output: z.object({
    messages: z.array(messageSummarySchema).describe('Matching email messages'),
    next_page_token: z.string().nullable().describe('Pass back to get the next page; null when there are no more'),
  }),
  handle: async params => {
    const data = await api<{ value: RawMessage[]; '@odata.nextLink'?: string }>('/me/messages', {
      query: {
        $search: `"${params.query}"`,
        $select: MESSAGE_SUMMARY_FIELDS,
        $top: params.limit ?? 10,
        ...(params.next_page_token ? pageQuery(params.next_page_token) : {}),
      },
    });
    const messages = data.value ?? [];
    return {
      messages: messages.map(mapMessageSummary),
      next_page_token: nextPageToken(data['@odata.nextLink'], messages.length),
    };
  },
});
