import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest } from '../workbook-rest.js';

/** A comment segment of a resource path. */
export const commentPath = (id: string): string => `comments('${id.replace(/'/g, "''")}')`;

export const updateComment = defineTool({
  name: 'update_comment',
  displayName: 'Update Comment',
  description:
    'Resolve or reopen a comment thread, or change its text. Take the id from list_comments. Pass resolved=true ' +
    'to resolve or false to reopen, or content to replace the text — one change per call, since Excel refuses a ' +
    'request that does both. Runs inside the open editing session.',
  summary: 'Resolve, reopen or edit a comment',
  icon: 'message-square',
  group: 'Review',
  input: z.object({
    id: z.string().min(1).describe('Comment id from list_comments (e.g., "{0CDF7FD1-...}")'),
    resolved: z.boolean().optional().describe('true resolves the thread, false reopens it'),
    content: z.string().min(1).optional().describe('New comment text'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    if ((params.resolved === undefined) === (params.content === undefined)) {
      throw ToolError.validation('Pass exactly one of resolved or content; Excel refuses a request that changes both.');
    }
    return workbookRest(
      'Patch',
      commentPath(params.id),
      params.content === undefined ? { resolved: params.resolved } : { content: params.content },
    );
  },
});
