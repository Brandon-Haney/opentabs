import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpcForm } from '../wrike-api.js';

interface AddCommentResponse {
  commentId?: number | string;
}

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Post a comment on a task. The text is treated as HTML (plain text is fine too). Returns the new comment id. To read existing comments, use list_task_comments.',
  summary: 'Post a comment on a task',
  icon: 'message-square-plus',
  group: 'Comments',
  input: z.object({
    task_id: z.string().describe('The task id to comment on'),
    text: z.string().min(1).describe('Comment text (HTML or plain text)'),
  }),
  output: z.object({
    id: z.string().describe('The new comment id'),
  }),
  handle: async params => {
    const data = await rpcForm<AddCommentResponse>('stream_add_comment', {
      data: JSON.stringify({
        text: params.text,
        entityId: Number(params.task_id),
        entityType: 'task',
        subject: null,
        userMentions: [],
        attachments: {},
        isEmailComment: false,
      }),
      commentFormat: 'html',
    });
    return { id: data.commentId !== undefined && data.commentId !== null ? String(data.commentId) : '' };
  },
});
