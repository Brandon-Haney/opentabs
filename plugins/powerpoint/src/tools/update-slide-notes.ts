import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, replaceNotesText, requireSlideFile, TEXT_DECODER, TEXT_ENCODER } from '../pptx-utils.js';
import { ensureNotesSlide } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const updateSlideNotes = defineTool({
  name: 'update_slide_notes',
  displayName: 'Update Slide Notes',
  description:
    'Set the speaker notes for a specific slide. Downloads the PPTX, writes the notes XML, and re-uploads. If the slide has no notes yet, an empty notes part is created automatically. Use \\n for line breaks.',
  summary: 'Modify speaker notes on a slide',
  icon: 'notebook-pen',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    notes: z.string().describe('New speaker notes text'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the update succeeded'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);

      // Create an empty notes part if the slide has none, so notes can be added
      // to any slide — not just ones that already have a notes file.
      const notesFile = ensureNotesSlide(entries, file);
      const notesData = entries.get(notesFile);
      if (!notesData) throw ToolError.internal(`Notes file not found in archive: ${notesFile}`);

      entries.set(notesFile, TEXT_ENCODER.encode(replaceNotesText(TEXT_DECODER.decode(notesData), params.notes)));
      return { success: true };
    }),
});
