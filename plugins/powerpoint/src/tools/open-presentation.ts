import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { openPresentation } from '../pptx-utils.js';
import { driveIdInput } from './schemas.js';

export const openPresentationTool = defineTool({
  name: 'open_presentation',
  displayName: 'Open Presentation Session',
  description:
    'Open an edit session for a presentation. Downloads the PPTX once and caches it in memory so subsequent edit ' +
    'tools (add_shape, update_shape, delete_shape, add_image, duplicate_slide, etc.) run without round-tripping ' +
    'through Graph. Captures the file eTag so commit_presentation can detect concurrent edits via If-Match. ' +
    'Call commit_presentation when done, or discard_presentation to throw away pending changes. ' +
    'Sessions auto-expire after 10 minutes of inactivity. ' +
    'To edit a file that lives in another user’s OneDrive, pass its drive_id and leave that file closed in the ' +
    'browser — opening it takes a co-authoring lock that makes the commit fail with HTTP 423. The tab only ' +
    'supplies the access token, so any presentation may stay open in it. ' +
    'Sessions are held per browser tab, so pass the same tabId to every tool from open through commit.',
  summary: 'Open a batched edit session for a presentation',
  icon: 'folder-open',
  group: 'Sessions',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
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
  handle: params => openPresentation(params.item_id, params.drive_id),
});
