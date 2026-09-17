import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest } from '../workbook-rest.js';
import { commentPath } from './update-comment.js';

export const deleteComment = defineTool({
  name: 'delete_comment',
  displayName: 'Delete Comment',
  description:
    'Delete a comment thread and its replies, like Review → Delete Comment. Take the id from list_comments. Runs ' +
    'inside the open editing session.',
  summary: 'Delete a comment thread',
  icon: 'trash-2',
  group: 'Review',
  input: z.object({
    id: z.string().min(1).describe('Comment id from list_comments'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Delete', commentPath(params.id)),
});
