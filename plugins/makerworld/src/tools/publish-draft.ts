import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiVoid } from '../makerworld-api.js';

export const publishDraft = defineTool({
  name: 'publish_draft',
  displayName: 'Publish Draft',
  description:
    'Submit a draft for publication, making the model public on your profile. This is a public, outward-facing action — confirm with the user before calling it, and have them review the draft in the browser first. MakerWorld runs the submission through moderation, so the model may sit in a verifying state before it appears. Use list_drafts to find draft IDs.',
  summary: 'Publish a draft model publicly',
  icon: 'send',
  group: 'Uploads',
  input: z.object({
    draft_id: z.number().int().describe('Draft ID to publish, from upload_model or list_drafts'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the draft was submitted for publication'),
  }),
  handle: async params => {
    await apiVoid('design-service', `/my/draft/${params.draft_id}/submit`, { method: 'POST', body: {} });
    return { success: true };
  },
});
