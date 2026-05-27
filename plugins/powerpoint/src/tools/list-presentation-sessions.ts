import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { listPresentationSessions } from '../pptx-utils.js';

export const listPresentationSessionsTool = defineTool({
  name: 'list_presentation_sessions',
  displayName: 'List Presentation Sessions',
  description:
    'List all open presentation sessions in the current tab, including which items are cached, whether they have ' +
    'dirty edits, and how long they have been idle. Useful for recovering context after a long conversation or ' +
    'confirming a session is still alive before committing.',
  summary: 'List all open batched edit sessions',
  icon: 'list',
  group: 'Sessions',
  input: z.object({}),
  output: z.object({
    sessions: z.array(
      z.object({
        drive_id: z.string(),
        item_id: z.string(),
        opened_at: z.number(),
        last_accessed_at: z.number(),
        dirty: z.boolean(),
        slides: z.number().int(),
        idle_seconds: z.number().int(),
      }),
    ),
  }),
  handle: () => Promise.resolve({ sessions: listPresentationSessions() }),
});
