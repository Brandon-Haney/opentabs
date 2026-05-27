import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discardPresentation } from '../pptx-utils.js';

export const discardPresentationTool = defineTool({
  name: 'discard_presentation',
  displayName: 'Discard Presentation Session',
  description:
    'Drop a presentation session without uploading. Any pending edits are lost. Idempotent — returns ' +
    '`discarded: false` if no session was open for the given item.',
  summary: 'Throw away a session without saving',
  icon: 'trash',
  group: 'Sessions',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
  }),
  output: z.object({
    item_id: z.string(),
    discarded: z.boolean().describe('True if a session was actually dropped, false if none was open'),
  }),
  handle: params => Promise.resolve(discardPresentation(params.item_id)),
});
