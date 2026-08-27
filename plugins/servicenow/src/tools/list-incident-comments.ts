import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, journalEntrySchema, parseJournal, type RawRecord, text } from './schemas.js';

const JOURNAL_FIELDS = 'number,sys_id,comments,work_notes';

export const listIncidentComments = defineTool({
  name: 'list_incident_comments',
  displayName: 'List Incident Comments',
  description:
    'Read the conversation on one incident, addressed either by its number (e.g., INC0010023) or by its ' +
    '32-character sys_id. Returns the customer-visible additional comments merged with the internal work notes, ' +
    'split into discrete entries carrying the author, timestamp, and body, newest first. Set include_work_notes ' +
    'to false to read only what the caller can see. The whole journal is returned in one call — there is no ' +
    'paging — so an incident with a long history yields a large result. Raises a not-found error when nothing ' +
    'matches, which is also what an access rule hiding the record looks like.',
  summary: 'Read the comments and work notes on one incident',
  icon: 'message-square',
  group: 'Incidents',
  input: z.object({
    incident: z
      .string()
      .min(1)
      .describe('Incident number (e.g., INC0010023) or the 32-character sys_id of the incident'),
    include_work_notes: z
      .boolean()
      .optional()
      .describe('Whether to include internal work notes alongside the customer-visible comments (default true)'),
  }),
  output: z.object({
    number: z.string().describe('Number of the incident the entries belong to (e.g., INC0010023)'),
    entries: z
      .array(journalEntrySchema)
      .describe('Journal entries, newest first; entries with no recorded timestamp sort last'),
    total: z.number().int().describe('Number of entries returned — the full journal, since this tool does not page'),
  }),
  handle: async params => {
    const identifier = params.incident.trim();
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `number=${escapeQueryValue(identifier)}`;

    const page = await tableQuery<RawRecord>('incident', { query, fields: JOURNAL_FIELDS, limit: 1 });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(
        `No incident matches "${identifier}" — check the number, or the record may be restricted.`,
      );
    }

    const includeWorkNotes = params.include_work_notes ?? true;
    const entries = [
      ...parseJournal(text(record.comments), 'Additional comments'),
      ...(includeWorkNotes ? parseJournal(text(record.work_notes), 'Work notes') : []),
    ].sort((a, b) => b.created_on.localeCompare(a.created_on));

    return { number: text(record.number), entries, total: entries.length };
  },
});
