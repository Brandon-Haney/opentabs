import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readComments } from '../comments.js';
import { downloadPptx, getSlideList, isSessionOpen } from '../pptx-utils.js';
import { commentSchema } from './schemas.js';

export const getComments = defineTool({
  name: 'get_comments',
  displayName: 'Get Comments',
  description:
    'Read reviewer comments and their threaded replies from a PowerPoint presentation. Downloads the PPTX and parses its comment parts, resolving each author id to a display name. Returns the whole deck by default, or a single slide when slide_number is given. Only comments in the last saved version are visible — comments that have been resolved or deleted are not retained in the file.',
  summary: 'Read comments and replies from a presentation',
  icon: 'message-square',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Only return comments on this slide (1-indexed). Omit for every comment in the presentation.'),
  }),
  output: z.object({
    comments: z.array(commentSchema).describe('Comments in slide order, then in the order stored on each slide'),
    total: z.number().int().describe('Number of comments returned'),
    from_open_session: z
      .boolean()
      .describe(
        'True when served from an open open_presentation session, meaning the result reflects that session snapshot rather than the current saved file — comments added by others since the session opened will be missing',
      ),
  }),
  handle: async params => {
    // Observed before downloadPptx, which transparently serves session entries.
    const fromOpenSession = await isSessionOpen(params.item_id);

    const entries = await downloadPptx(params.item_id);
    const slideFiles = getSlideList(entries);

    if (params.slide_number !== undefined && params.slide_number > slideFiles.length) {
      throw ToolError.notFound(`Slide ${params.slide_number} not found — presentation has ${slideFiles.length} slides`);
    }

    const all = readComments(entries, slideFiles);
    const comments = params.slide_number === undefined ? all : all.filter(c => c.slide_number === params.slide_number);

    return { comments, total: comments.length, from_open_session: fromOpenSession };
  },
});
