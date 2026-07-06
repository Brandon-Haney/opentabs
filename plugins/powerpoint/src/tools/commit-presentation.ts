import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { commitPresentation } from '../pptx-utils.js';

export const commitPresentationTool = defineTool({
  name: 'commit_presentation',
  displayName: 'Commit Presentation Session',
  description:
    "Flush a session's pending edits to the Graph API with an optimistic If-Match check against the eTag captured " +
    'at open time. If the file changed in the browser since the session was opened, the commit is refused and pending ' +
    'edits are preserved — call discard_presentation to drop them, or inspect and commit anyway via a new session. ' +
    'If the session has no dirty edits, the commit is a no-op that just closes the session.',
  summary: 'Commit pending session edits with eTag safety',
  icon: 'save',
  group: 'Sessions',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: z
      .string()
      .optional()
      .describe(
        'Drive the session was opened on. Defaults to the current tab. Pass the drive_id from open_presentation ' +
          'or list_presentation_sessions to commit a session opened on a different deck/drive than the tab now shows.',
      ),
  }),
  output: z.object({
    item_id: z.string(),
    slides: z.number().int().describe('Number of slides in the committed presentation'),
    was_dirty: z.boolean().describe('Whether any edits were actually uploaded (false = no-op commit)'),
    committed: z.boolean(),
  }),
  handle: params => commitPresentation(params.item_id, params.drive_id),
});
