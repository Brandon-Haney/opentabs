import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { currentUser, fieldAccess, tableMeta, tableUpdateRequest } from '../servicenow-api.js';
import {
  commentRecordSchema,
  commentTextSchema,
  findOwnEntry,
  journalEntries,
  journalFieldSchema,
  resolveCommentTarget,
} from './comment-target.js';
import { journalEntrySchema, mapTask, reference, referenceSchema, taskShape, text } from './schemas.js';

const RECENT_ENTRIES = 3;
const RECENT_ENTRY_LENGTH = 500;

/** Shortens an entry for context, since a journal entry can hold a whole pasted log. */
const excerpt = (body: string): string =>
  body.length > RECENT_ENTRY_LENGTH ? `${body.slice(0, RECENT_ENTRY_LENGTH)}…` : body;

export const previewComment = defineTool({
  name: 'preview_comment',
  displayName: 'Preview Comment',
  description:
    'Show exactly what add_comment would do, without writing anything. Works on any task-derived record — ' +
    'incidents, requested items, catalog tasks, changes, problems. Returns the record the entry would land on, the ' +
    'people it concerns, the latest entries so the reply fits the conversation, whether the signed-in user may ' +
    'write that field on this record (read from the instance with its access rules applied, "unknown" when the ' +
    'instance does not say), and the exact request add_comment would send. Issues only reads. Call this and show ' +
    'the result to the user before calling add_comment.',
  summary: 'Check a comment before posting it, without writing',
  icon: 'message-square-dashed',
  group: 'Comments',
  input: z.object({
    record: commentRecordSchema,
    field: journalFieldSchema,
    text: commentTextSchema,
  }),
  output: z.object({
    record: z
      .object({
        ...taskShape,
        table: z.string().describe('Table the record lives in, which is where the update would be sent'),
        table_label: z.string().describe('Human-readable label of that table (e.g., Incident)'),
      })
      .describe('The record the entry would land on'),
    requester: referenceSchema.describe(
      'Who the record is for: the caller, else the requested-for user, else whoever opened it',
    ),
    watch_list: z.string().describe('Users copied on customer-visible updates, comma-separated, empty when none'),
    work_notes_list: z.string().describe('Users copied on work notes, comma-separated, empty when none'),
    field_label: z.string().describe("The field's label on this instance, which is what people see in the UI"),
    access: z
      .enum(['writable', 'read_only', 'unknown'])
      .describe('Whether the signed-in user may write the field on this record'),
    already_posted: z.boolean().describe('Whether the signed-in user already has an entry with this exact body'),
    warnings: z.array(z.string()).describe('Reasons to look again before posting, empty when there are none'),
    recent_entries: z
      .array(journalEntrySchema)
      .describe('Latest entries on the same field, newest first, each cut to 500 characters'),
    request: z
      .object({
        method: z.string().describe('HTTP method'),
        path: z.string().describe('Request path on the instance'),
        body: z.string().describe('JSON request body'),
      })
      .describe('The exact request add_comment would send'),
  }),
  handle: async params => {
    const body = params.text.trim();
    if (!body) throw ToolError.validation('The comment has no text.');

    const [user, target] = await Promise.all([currentUser(), resolveCommentTarget(params.record)]);
    const [access, columns] = await Promise.all([
      fieldAccess(target.table, target.sysId, params.field),
      tableMeta(target.table),
    ]);

    const task = mapTask(target.record);
    const alreadyPosted = !!findOwnEntry(target.record, params.field, body, user.user_display_name ?? '');

    const warnings: string[] = [];
    if (!task.active) warnings.push(`${task.number} is closed (${task.state.label}) — a new entry may be rejected.`);
    if (access === 'read_only') warnings.push(`This account may not write ${params.field} on ${task.number}.`);
    if (alreadyPosted) warnings.push('You already posted this exact text here, so add_comment will refuse it.');

    const { caller_id, requested_for, opened_by, watch_list, work_notes_list } = target.record;
    return {
      record: { ...task, table: target.table, table_label: target.tableLabel },
      requester: reference([caller_id, requested_for, opened_by].find(person => text(person))),
      watch_list: text(watch_list),
      work_notes_list: text(work_notes_list),
      field_label: columns[params.field]?.label ?? params.field,
      access,
      already_posted: alreadyPosted,
      warnings,
      recent_entries: journalEntries(target.record, params.field)
        .slice(0, RECENT_ENTRIES)
        .map(entry => ({ ...entry, text: excerpt(entry.text) })),
      request: tableUpdateRequest(target.table, target.sysId, { [params.field]: body }),
    };
  },
});
