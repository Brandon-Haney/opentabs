import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  downloadPptx,
  extractNotesText,
  extractSlideText,
  getNotesForSlide,
  requireSlideFile,
  TEXT_DECODER,
} from '../pptx-utils.js';
import { isSlideHidden } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const getSlideContent = defineTool({
  name: 'get_slide_content',
  displayName: 'Get Slide Content',
  description:
    'Get detailed text content and speaker notes for a specific slide by number (1-indexed). Downloads the PPTX file and extracts all text and notes.',
  summary: 'Get text and notes for a specific slide',
  icon: 'file-text',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
  }),
  output: z.object({
    number: z.number().int().describe('Slide number'),
    texts: z.array(z.string()).describe('Text content from the slide'),
    notes: z.string().describe('Speaker notes text (empty if no notes)'),
    hidden: z.boolean().describe('True when the slide is hidden from the slide show'),
    file: z.string().describe('Internal file path within the PPTX archive'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id, params.drive_id);
    const file = requireSlideFile(entries, params.slide_number);
    const slideData = entries.get(file);
    const slideXml = slideData ? TEXT_DECODER.decode(slideData) : '';
    const texts = slideXml ? extractSlideText(slideXml) : [];

    let notes = '';
    const notesFile = getNotesForSlide(entries, file);
    if (notesFile) {
      const notesData = entries.get(notesFile);
      if (notesData) {
        notes = extractNotesText(TEXT_DECODER.decode(notesData));
      }
    }

    return { number: params.slide_number, texts, notes, hidden: isSlideHidden(slideXml), file };
  },
});
