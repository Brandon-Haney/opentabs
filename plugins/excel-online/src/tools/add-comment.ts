import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges } from '../bridge.js';

/**
 * Build the `ApplyThreadedComment` options. Comment content is a Quill delta —
 * `{"ops":[{"insert": text}]}`. A top-level comment has `parentCommentId: null`;
 * a reply passes the parent thread's comment id. The `commentId` is a
 * client-generated GUID passed in so this builder stays pure and testable.
 * `options: 1` and an empty `taskHistoryRecords` array are constants the web
 * client sends (verified from a live capture).
 */
export const buildAddCommentOptions = (
  worksheet: string,
  cell: string,
  text: string,
  commentId: string,
  parentId: string | undefined,
): Record<string, unknown> => ({
  options: 1,
  content: JSON.stringify({ ops: [{ insert: text }] }),
  anchor: selectedRanges(worksheet, cell),
  commentId,
  parentCommentId: parentId ?? null,
  isResolved: false,
  taskHistoryRecords: [],
});

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Add a threaded comment to a cell, or reply to an existing thread by passing its parent_id. Comments ' +
    "are not available through the standard workbook API — driven through Excel's internal service via the " +
    'frame bridge.',
  summary: 'Add a threaded comment or reply',
  icon: 'message-square',
  group: 'Review',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    cell: z.string().describe('Single cell in A1 notation to anchor the comment to (e.g., "B3")'),
    text: z.string().describe('Comment text'),
    parent_id: z
      .string()
      .optional()
      .describe('Comment id of the thread to reply to. Omit to start a new top-level comment.'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'ApplyThreadedComment',
      buildAddCommentOptions(params.worksheet, params.cell, params.text, crypto.randomUUID(), params.parent_id),
    ),
});
