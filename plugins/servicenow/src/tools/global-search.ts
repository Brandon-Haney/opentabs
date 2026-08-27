import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, type RawRecord, text, value } from './schemas.js';

/** Tables the search covers, in the order results are returned. */
const SEARCHABLE = [
  { name: 'incident', label: 'Incidents' },
  { name: 'change_request', label: 'Change Requests' },
  { name: 'problem', label: 'Problems' },
  { name: 'sc_req_item', label: 'Requested Items' },
  { name: 'kb_knowledge', label: 'Knowledge Articles' },
] as const;

const TABLE_NAMES = SEARCHABLE.map(entry => entry.name);

const DEFAULT_LIMIT_PER_TABLE = 5;

/**
 * ServiceNow's text-index operator.
 *
 * Unlike a LIKE condition, which only inspects the fields it names, this searches the indexed
 * body of the record — description and journal text included — so it finds records whose short
 * description never mentions the term.
 */
const textIndexQuery = (term: string): string => `123TEXTQUERY321=${term}`;

export const globalSearch = defineTool({
  name: 'global_search',
  displayName: 'Global Search',
  description:
    "Search several tables at once using ServiceNow's full-text index, and return the matches grouped by the " +
    'table they live in. Use it when the table holding a record is unknown, or when the search term may appear ' +
    'in a record body rather than its title: the index covers description and journal text, so it finds records ' +
    'a title-only search misses. Passing an exact record number resolves that one record. Each table is capped ' +
    'at a handful of records while the per-table total reports how many matched, so this locates records rather ' +
    'than enumerating them — once the table is known, re-query it with the matching search tool for full fields, ' +
    'filtering, and paging. Searches incidents, changes, problems, requested items, and knowledge articles ' +
    'unless "tables" narrows it, and results are not scoped to the signed-in user.',
  summary: 'Full-text search across several ServiceNow tables',
  icon: 'globe',
  group: 'Platform',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Search term — a record number, phrase, or keyword (e.g., "INC0010023" or "vpn")'),
    tables: z
      .array(z.enum(TABLE_NAMES as unknown as [string, ...string[]]))
      .optional()
      .describe('Tables to search. Omit to search all of them.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Maximum records returned per table (default 5, max 20)'),
  }),
  output: z.object({
    results: z
      .array(
        z.object({
          table: z.string().describe('Table name, to pass to the matching search or query tool'),
          table_label: z.string().describe('Human-readable table name'),
          total: z.number().int().describe('Total records in this table matching the term, not just those returned'),
          records: z.array(
            z.object({
              number: z.string().describe('Record number'),
              sys_id: z.string().describe('sys_id, for a follow-up read of the full record'),
              short_description: z.string().describe('One-line summary of the record'),
            }),
          ),
        }),
      )
      .describe('One entry per searched table that returned at least one match, in table order'),
    total_matches: z.number().int().describe('Sum of the per-table totals across every table searched'),
  }),
  handle: async params => {
    const term = escapeQueryValue(params.query);
    if (!term) return { results: [], total_matches: 0 };

    const limit = params.limit ?? DEFAULT_LIMIT_PER_TABLE;
    const selected = params.tables?.length
      ? SEARCHABLE.filter(entry => params.tables?.includes(entry.name))
      : SEARCHABLE;

    // A table the user cannot read rejects the whole request, so failures are dropped rather
    // than surfaced — a partial result is more useful here than none.
    const pages = await Promise.all(
      selected.map(async entry => {
        try {
          const page = await tableQuery<RawRecord>(entry.name, {
            query: textIndexQuery(term),
            fields: 'number,sys_id,short_description',
            limit,
          });
          return { entry, page };
        } catch {
          return null;
        }
      }),
    );

    const results = pages
      .filter(result => result !== null)
      .filter(result => result.page.records.length > 0)
      .map(result => ({
        table: result.entry.name,
        table_label: result.entry.label,
        total: result.page.total,
        records: result.page.records.map(record => ({
          number: text(record.number),
          sys_id: value(record.sys_id),
          short_description: text(record.short_description),
        })),
      }));

    return { results, total_matches: results.reduce((sum, result) => sum + result.total, 0) };
  },
});
