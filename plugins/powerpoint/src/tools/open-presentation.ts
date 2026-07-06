import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { openPresentation } from '../pptx-utils.js';

export const openPresentationTool = defineTool({
  name: 'open_presentation',
  displayName: 'Open Presentation Session',
  description:
    'Open an edit session for a presentation. Downloads the PPTX once and caches it in memory so subsequent edit ' +
    'tools (add_shape, update_shape, delete_shape, add_image, duplicate_slide, etc.) run without round-tripping ' +
    'through Graph. Captures the file eTag so commit_presentation can detect concurrent edits via If-Match. ' +
    'Call commit_presentation when done, or discard_presentation to throw away pending changes. ' +
    'Sessions auto-expire after 10 minutes of inactivity.',
  summary: 'Open a batched edit session for a presentation',
  icon: 'folder-open',
  group: 'Sessions',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
  }),
  output: z.object({
    item_id: z.string(),
    drive_id: z
      .string()
      .describe('Drive the session was opened on — pass to commit/discard_presentation if the tab navigates away'),
    etag: z.string().describe('ETag captured at open time — used as If-Match on commit'),
    slides: z.number().int().describe('Number of slides in the presentation'),
    opened_at: z.number().describe('Unix timestamp in milliseconds when the session was opened'),
  }),
  handle: params => openPresentation(params.item_id),
});
