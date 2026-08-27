import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, KNOWLEDGE_FIELDS, knowledgeSchema, mapKnowledge, type RawRecord, text } from './schemas.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const MAX_CODE_POINT = 0x10ffff;

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const LINE_BREAK_TAG = /<(?:br|hr)\b[^>]*>/gi;
const CELL_END_TAG = /<\/(?:td|th)\s*>/gi;
const BLOCK_END_TAG = /<\/(?:p|div|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|pre)\s*>/gi;
const ANY_TAG = /<[^>]*>/g;
const TRAILING_SPACE = /[^\S\n]+$/gm;
const BLANK_RUN = /\n{3,}/g;

const decodeEntity = (entity: string): string | null => {
  if (!entity.startsWith('#')) return NAMED_ENTITIES[entity.toLowerCase()] ?? null;

  const hexadecimal = entity[1] === 'x' || entity[1] === 'X';
  const code = Number.parseInt(hexadecimal ? entity.slice(2) : entity.slice(1), hexadecimal ? 16 : 10);
  return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : null;
};

/**
 * Renders an article body as readable plain text.
 *
 * ServiceNow stores article bodies as HTML, and the instance serves a Trusted Types policy that
 * blocks `innerHTML`, so the markup is reduced with regexes instead of a parser: closing block
 * tags become line breaks, every remaining tag is dropped, and entities are decoded afterwards
 * so escaped angle brackets in the prose are never mistaken for markup.
 */
const htmlToPlainText = (html: string): string =>
  html
    .replace(/\r\n?/g, '\n')
    .replace(SCRIPT_OR_STYLE, '')
    .replace(LINE_BREAK_TAG, '\n')
    .replace(CELL_END_TAG, ' ')
    .replace(BLOCK_END_TAG, '\n\n')
    .replace(ANY_TAG, '')
    .replace(ENTITY, (match, entity: string) => decodeEntity(entity) ?? match)
    .replace(TRAILING_SPACE, '')
    .replace(BLANK_RUN, '\n\n')
    .trim();

export const getKnowledgeArticle = defineTool({
  name: 'get_knowledge_article',
  displayName: 'Get Knowledge Article',
  description:
    'Read one knowledge article in full, including its body converted from HTML to plain text. Accepts either ' +
    'the article number (e.g., KB0010023) or the article sys_id, so a result from search_knowledge can be ' +
    'passed straight through. Returns the same summary fields as a search result plus the article body. An ' +
    'article the signed-in user is not entitled to read is reported as not found, because access rules hide ' +
    'it from the query rather than rejecting it.',
  summary: 'Read a knowledge article by number or sys_id',
  icon: 'file-text',
  group: 'Knowledge',
  input: z.object({
    article: z.string().min(1).describe('Article number (e.g., KB0010023) or the article sys_id'),
  }),
  output: z.object({
    article: knowledgeSchema
      .extend({
        body: z.string().describe('Article body as plain text, with HTML markup removed and entities decoded'),
      })
      .describe('The article, with its body text'),
  }),
  handle: async params => {
    const article = escapeQueryValue(params.article);
    // An article number is shared by every revision ever published, so ordering by the `latest`
    // flag is what separates the current text from a superseded one. A sys_id addresses a single
    // revision directly and is returned as asked.
    const page = await tableQuery<RawRecord>('kb_knowledge', {
      query: `number=${article}^ORsys_id=${article}^ORDERBYDESClatest^ORDERBYDESCsys_updated_on`,
      fields: `${KNOWLEDGE_FIELDS},text`,
      limit: 1,
    });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(`No knowledge article found for "${params.article}" — pass a KB number or sys_id.`);
    }

    return { article: { ...mapKnowledge(record), body: htmlToPlainText(text(record.text)) } };
  },
});
