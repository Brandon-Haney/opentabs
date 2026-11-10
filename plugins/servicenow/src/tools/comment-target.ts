import { ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableGet, tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, parseJournal, type RawRecord, TASK_FIELDS, text, value } from './schemas.js';

/** The two journal fields a task record accepts entries on, with the kind their entries are recorded under. */
const JOURNAL_KINDS = { comments: 'Additional comments', work_notes: 'Work notes' } as const;

export type JournalField = keyof typeof JOURNAL_KINDS;

export const commentRecordSchema = z
  .string()
  .min(1)
  .describe('Record number (e.g., INC0010023, RITM0010023, SCTASK0010023, CHG0010023) or its 32-character sys_id');

export const journalFieldSchema = z
  .enum(['comments', 'work_notes'])
  .describe(
    'Where the entry goes. "comments" is shared with the requester and usually emails them; ' +
      '"work_notes" is internal to the teams working the record. There is no default, so the audience is always chosen.',
  );

export const commentTextSchema = z.string().min(1).describe('Body of the entry, posted exactly as written');

/** A task record resolved to the table it really lives in, with the fields a comment decision needs. */
export interface CommentTarget {
  table: string;
  tableLabel: string;
  sysId: string;
  record: RawRecord;
}

/**
 * Resolves a number or sys_id to the concrete table holding the record.
 *
 * The lookup uses the `task` parent table so any task type can be addressed, but reads and writes
 * then use the concrete table, because access rules and business rules are defined per table.
 */
export const resolveCommentTarget = async (identifier: string): Promise<CommentTarget> => {
  const trimmed = identifier.trim();
  const query = isSysId(trimmed) ? `sys_id=${trimmed}` : `number=${escapeQueryValue(trimmed)}`;
  const page = await tableQuery<RawRecord>('task', { query, fields: 'sys_id,sys_class_name', limit: 1 });

  const found = page.records[0];
  if (!found) {
    throw ToolError.notFound(`No task matches "${trimmed}" — check the number, or the record may be restricted.`);
  }

  const table = value(found.sys_class_name);
  const sysId = value(found.sys_id);
  const record = await tableGet<RawRecord>(
    table,
    sysId,
    `${TASK_FIELDS},comments,work_notes,caller_id,requested_for,opened_by,watch_list,work_notes_list`,
  );
  if (!record) {
    throw ToolError.notFound(`Task "${trimmed}" exists but its ${table} record could not be read.`);
  }

  return { table, tableLabel: text(found.sys_class_name), sysId, record };
};

/** The entries on one journal field of a record, in the newest-first order ServiceNow stores them. */
export const journalEntries = (record: RawRecord, field: JournalField) =>
  parseJournal(text(record[field]), JOURNAL_KINDS[field]);

/** Compares entry bodies the way the journal stores them, where line endings and padding can change. */
const sameBody = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** The signed-in user's existing entry with this body, if they already posted it. */
export const findOwnEntry = (record: RawRecord, field: JournalField, body: string, author: string) =>
  journalEntries(record, field).find(entry => entry.author === author && sameBody(entry.text, body));

/**
 * Finds the entry a write produced by looking only at entries newer than the pre-write read.
 *
 * The body is the primary match. The author is the fallback, for an instance that reformats the
 * text on save. Another person's concurrent entry matches neither, so it cannot confirm this write.
 */
export const findPostedEntry = (
  before: RawRecord,
  after: RawRecord,
  field: JournalField,
  body: string,
  author: string,
) => {
  const entries = journalEntries(after, field);
  const added = entries.slice(0, Math.max(0, entries.length - journalEntries(before, field).length));
  return added.find(entry => sameBody(entry.text, body)) ?? added.find(entry => entry.author === author);
};
