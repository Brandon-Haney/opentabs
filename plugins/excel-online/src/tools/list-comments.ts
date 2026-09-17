import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest } from '../workbook-rest.js';

/** The comment fields worth returning; the rest are only served when selected. */
export const LIST_COMMENTS_PATH = 'comments?$select=id,content,cellAddress,authorName,creationDate,resolved';

export const listComments = defineTool({
  name: 'list_comments',
  displayName: 'List Comments',
  description:
    'List the threaded comments in the open workbook, like Review → Show Comments. The response is an OData ' +
    'JSON string whose "value" array holds each comment\'s id, content, cellAddress (sheet-qualified), authorName, ' +
    'creationDate and resolved flag. Pass an id to update_comment or delete_comment, or to add_comment as parent_id ' +
    'to reply. Runs inside the open editing session.',
  summary: 'List the workbook comments',
  icon: 'message-square',
  group: 'Review',
  input: z.object({}),
  output: bridgeOutputSchema,
  handle: async () => workbookRest('Get', LIST_COMMENTS_PATH),
});
