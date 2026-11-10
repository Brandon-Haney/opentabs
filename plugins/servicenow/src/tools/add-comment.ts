import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { currentUser, tableGet, tableUpdate } from '../servicenow-api.js';
import {
  commentRecordSchema,
  commentTextSchema,
  findOwnEntry,
  findPostedEntry,
  journalFieldSchema,
  resolveCommentTarget,
} from './comment-target.js';
import { journalEntrySchema, type RawRecord, text } from './schemas.js';

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Post one entry to a task-derived record — an incident, requested item, catalog task, change or problem — as ' +
    'the signed-in user. Call preview_comment first and get the user to approve the exact text and audience: an ' +
    'entry cannot be edited or deleted afterwards, and on "comments" the requester is usually emailed. The ' +
    "instance's own rules still run, so an update can also change the record's state. Reads the record back and " +
    'reports what it found in status. Never call this again for the same text unless status and the journal show ' +
    'it did not post; identical text from the same user is refused so a repeated call cannot post twice.',
  summary: 'Post a comment or work note on a record',
  icon: 'message-square-plus',
  group: 'Comments',
  input: z.object({
    record: commentRecordSchema,
    field: journalFieldSchema,
    text: commentTextSchema,
  }),
  output: z.object({
    number: z.string().describe('Number of the record written to (e.g., INC0010023)'),
    table: z.string().describe('Table the record lives in'),
    field: z.string().describe('Journal field the entry was sent to'),
    status: z
      .enum(['posted', 'not_in_journal', 'unverified'])
      .describe(
        '"posted": the entry is in the journal. "not_in_journal": the instance answered success but the record ' +
          'shows no new entry, which is how a field-level access rule refusal looks. "unverified": the instance ' +
          'accepted the request but the read-back failed. In the last two cases check the record before any retry.',
      ),
    entry: journalEntrySchema.nullable().describe('The entry found in the journal, null unless status is "posted"'),
  }),
  handle: async (params, context) => {
    const body = params.text.trim();
    if (!body) throw ToolError.validation('The comment has no text.');

    const user = await currentUser();
    const author = user.user_display_name ?? '';
    const target = await resolveCommentTarget(params.record);
    const number = text(target.record.number);

    if (findOwnEntry(target.record, params.field, body, author)) {
      throw ToolError.validation(`You already posted this exact text on ${number}.`, 'DUPLICATE_COMMENT');
    }

    context?.reportProgress({ progress: 1, total: 2, message: `Posting to ${number}` });
    await tableUpdate(target.table, target.sysId, { [params.field]: body });

    context?.reportProgress({ progress: 2, total: 2, message: `Confirming the entry on ${number}` });
    const result = { number, table: target.table, field: params.field };

    // Everything after the write resolves rather than throws. An auth error here would make session
    // recovery run the whole tool again, posting the entry a second time.
    let after: RawRecord | null;
    try {
      after = await tableGet<RawRecord>(target.table, target.sysId, `number,${params.field}`);
    } catch {
      return { ...result, status: 'unverified' as const, entry: null };
    }
    if (!after) return { ...result, status: 'unverified' as const, entry: null };

    const entry = findPostedEntry(target.record, after, params.field, body, author);
    return entry
      ? { ...result, status: 'posted' as const, entry }
      : { ...result, status: 'not_in_journal' as const, entry: null };
  },
});
