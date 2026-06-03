import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { substrateSearch } from '../teams-api.js';
import { SEARCH_MESSAGE_EXTENSION_FIELDS, mapSearchResult, messageSearchResultSchema } from './schemas.js';

interface SearchResponse {
  EntitySets?: Array<{
    ResultSets?: Array<{
      Results?: Array<Record<string, unknown>>;
      Total?: number;
      MoreResultsAvailable?: boolean;
    }>;
  }>;
}

export const searchMessages = defineTool({
  name: 'search_messages',
  displayName: 'Search Messages',
  description:
    "Search across all of the user's Teams chats and channels for messages matching a query, ranked by relevance. Each result is a single message — pass its conversation_id to read_messages to read the surrounding thread (results may include nearby messages from a strongly-matching conversation). This is keyword/KQL search like Outlook, NOT semantic: do not pass a natural-language question — pull out the distinctive terms instead. A few specific keywords (names, unique nouns, numbers, error codes) beat common words, which pull in large meeting/channel threads as noise. Narrow with the operators described on the query field. Enterprise Teams (teams.microsoft.com) only.",
  summary: 'Search Teams messages',
  icon: 'search',
  group: 'Messages',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Keyword/KQL search text (not semantic) — use distinctive terms, not a sentence. ' +
          'Operators, combinable: ' +
          '"exact phrase" (contiguous match); ' +
          'from:"Display Name" or from:email@domain (sender); ' +
          'sent:YYYY-MM-DD or a range sent:START..END (when sent); ' +
          'hasattachment:true (messages with files). ' +
          'Examples: from:"Jane Doe" budget — messages from a person about a topic; ' +
          '"quarterly forecast" — an exact phrase; ' +
          'invoice hasattachment:true — a shared file; ' +
          'migration sent:2026-01-01..2026-03-31 — within a date range. ' +
          'If a query is noisy, drop common words and keep the 1-2 most distinctive terms, then add from:/sent: to narrow.',
      ),
    limit: z.number().int().min(1).max(50).optional().describe('Number of results to return (default 25, max 50)'),
    offset: z.number().int().min(0).optional().describe('Number of results to skip for pagination (default 0)'),
  }),
  output: z.object({
    results: z.array(messageSearchResultSchema).describe('Matching messages, ranked by relevance'),
    total_count: z.number().describe('Total number of matching messages across the mailbox'),
    more_results_available: z.boolean().describe('Whether more results exist beyond this page'),
  }),
  handle: async params => {
    const size = params.limit ?? 25;
    const data = await substrateSearch<SearchResponse>({
      entityRequests: [
        {
          entityType: 'Message',
          contentSources: ['Teams'],
          fields: SEARCH_MESSAGE_EXTENSION_FIELDS,
          propertySet: 'Optimized',
          query: { queryString: params.query, displayQueryString: params.query },
          from: params.offset ?? 0,
          size,
          topResultsCount: 0,
        },
      ],
      cvid: crypto.randomUUID(),
      logicalId: crypto.randomUUID(),
      scenario: {
        Dimensions: [
          { DimensionName: 'QueryType', DimensionValue: 'Messages' },
          { DimensionName: 'FormFactor', DimensionValue: 'general.web.reactSearch' },
        ],
        Name: 'powerbar',
      },
    });

    const resultSet = data.EntitySets?.[0]?.ResultSets?.[0];
    const results = (resultSet?.Results ?? []).map(mapSearchResult);
    return {
      results,
      total_count: resultSet?.Total ?? results.length,
      more_results_available: resultSet?.MoreResultsAvailable ?? false,
    };
  },
});
