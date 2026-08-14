import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, replaceSlideText, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { driveIdInput } from './schemas.js';

export const updateSlideText = defineTool({
  name: 'update_slide_text',
  displayName: 'Update Slide Text',
  description:
    "Replace the text of a slide's first text box, one paragraph per line. Use \\n to separate lines. " +
    'Targets the first text box that already has content, falling back to the first (often empty) placeholder — ' +
    'it does not specifically resolve the title placeholder, so on slides where another text box comes first that ' +
    'box is edited. For precise control over a specific shape, use `update_shape` with a shape id from `get_slide_layout` instead.',
  summary: 'Replace text in a slide’s first text box',
  icon: 'pencil',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    text: z.string().describe('New text content for the slide (use \\n for line breaks)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the update succeeded'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      writeSlideXml(entries, file, replaceSlideText(readSlideXml(entries, file), params.text));
      return { success: true };
    }),
});
