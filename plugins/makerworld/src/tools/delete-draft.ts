import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiVoid } from '../makerworld-api.js';

export const deleteDraft = defineTool({
  name: 'delete_draft',
  displayName: 'Delete Draft',
  description:
    'Permanently delete an unpublished draft and the upload attached to it. This cannot be undone. Only affects drafts — published models are untouched. Use list_drafts to find draft IDs.',
  summary: 'Permanently delete an unpublished draft',
  icon: 'trash-2',
  group: 'Uploads',
  input: z.object({
    draft_id: z.number().int().describe('Draft ID to delete'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the draft was deleted'),
  }),
  handle: async params => {
    await apiVoid('design-service', `/my/draft/${params.draft_id}`, { method: 'DELETE' });
    return { success: true };
  },
});
