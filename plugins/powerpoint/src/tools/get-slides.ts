import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, extractSlideText, getNotesForSlide, getSlideList, TEXT_DECODER } from '../pptx-utils.js';
import { isSlideHidden } from '../slide-edit.js';
import { driveIdInput, slideSchema } from './schemas.js';

export const getSlides = defineTool({
  name: 'get_slides',
  displayName: 'Get Slides',
  description:
    'Get all slides from a PowerPoint presentation with their text content. ' +
    '`hidden` marks slides the author excluded from the slide show — usually backup, appendix, or superseded ' +
    "material. Treat hidden slides as deliberately outside the deck's narrative: exclude them when summarizing or " +
    'answering questions about what the deck says, unless the user asks about them specifically.',
  summary: 'List all slides with their text content',
  icon: 'layers',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
  }),
  output: z.object({
    slides: z.array(slideSchema).describe('All slides in the presentation'),
    total: z.number().int().describe('Total number of slides'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id, params.drive_id);
    const slideFiles = getSlideList(entries);

    const slides = slideFiles.map((file, index) => {
      const slideData = entries.get(file);
      const slideXml = slideData ? TEXT_DECODER.decode(slideData) : '';
      const texts = slideXml ? extractSlideText(slideXml) : [];
      const notesFile = getNotesForSlide(entries, file);

      return {
        number: index + 1,
        file,
        texts,
        has_notes: notesFile !== null,
        hidden: slideXml ? isSlideHidden(slideXml) : false,
      };
    });

    return { slides, total: slides.length };
  },
});
