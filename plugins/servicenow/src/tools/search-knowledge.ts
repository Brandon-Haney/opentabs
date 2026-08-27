import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  DEFAULT_LIMIT,
  equalsFragment,
  escapeQueryValue,
  KNOWLEDGE_FIELDS,
  knowledgeSchema,
  limitSchema,
  mapKnowledge,
  offsetSchema,
  type RawRecord,
  totalSchema,
} from './schemas.js';

export const searchKnowledge = defineTool({
  name: 'search_knowledge',
  displayName: 'Search Knowledge',
  description:
    'Search knowledge articles whose number, title, or body text contains the search term. Only the current ' +
    'revision of each published article is searched by default — ServiceNow keeps every past revision as its ' +
    'own record under the same article number, so without that filter one article returns once per version it ' +
    'has ever had. Results come back most-viewed first so the articles the service desk actually relies on ' +
    'lead. The body is matched but not returned — call get_knowledge_article with an article number (e.g., ' +
    'KB0010023) or sys_id to read one. Returns 20 articles per call by default and 100 at most; use offset to ' +
    'page through a larger result set.',
  summary: 'Search knowledge articles by number, title, or body',
  icon: 'book-open',
  group: 'Knowledge',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Free text matched as a case-insensitive substring against the article number, title, and body'),
    knowledge_base: z
      .string()
      .optional()
      .describe('sys_id of a single knowledge base to search; omit to search every base the user can read'),
    published_only: z
      .boolean()
      .optional()
      .describe('Restrict results to published articles (default true); set false to include drafts and retired'),
    include_superseded: z
      .boolean()
      .optional()
      .describe(
        'Include older revisions of an article as separate results (default false). Every revision keeps the ' +
          'same article number, so leaving this off is what keeps one article from appearing several times.',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    articles: z.array(knowledgeSchema).describe('Matching articles, most-viewed first'),
    total: totalSchema,
  }),
  handle: async params => {
    const term = escapeQueryValue(params.query);
    const publishedOnly = params.published_only ?? true;

    // Every revision of an article keeps its number, so without the `latest` filter a single
    // article returns once per version it has ever had.
    const query = andQuery(
      params.include_superseded === true ? undefined : 'latest=true',
      publishedOnly ? 'workflow_state=published' : undefined,
      equalsFragment('kb_knowledge_base', params.knowledge_base),
      term ? `numberLIKE${term}^ORshort_descriptionLIKE${term}^ORtextLIKE${term}` : undefined,
      'ORDERBYDESCsys_view_count',
    );

    const page = await tableQuery<RawRecord>('kb_knowledge', {
      query,
      fields: KNOWLEDGE_FIELDS,
      limit: params.limit ?? DEFAULT_LIMIT,
      offset: params.offset,
    });

    return { articles: page.records.map(mapKnowledge), total: page.total };
  },
});
