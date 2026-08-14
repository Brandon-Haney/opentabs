import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { isSlideHidden, setSlideHidden } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const setSlideHiddenTool = defineTool({
  name: 'set_slide_hidden',
  displayName: 'Hide or Show Slide',
  description:
    'Hide a slide from the slide show, or restore it. A hidden slide stays in the deck, keeps its number, and can ' +
    'still be read and edited — it is simply skipped when presenting, and appears greyed out in the thumbnail rail. ' +
    'Authors hide slides to keep backup, appendix, or superseded material in the file without showing it, so treat a ' +
    'hidden slide as deliberately out of the narrative: do not unhide one unless the user asked for it, and do not ' +
    "assume its content is part of the deck's message. Check current state with `get_slides`, which reports " +
    '`hidden` for every slide.',
  summary: 'Hide a slide from the slide show, or restore it',
  icon: 'eye-off',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    hidden: z.boolean().describe('True to hide the slide from the show, false to restore it'),
  }),
  output: z.object({
    slide_number: z.number().int().describe('The slide that was changed (1-indexed)'),
    hidden: z.boolean().describe('Whether the slide is now hidden'),
    changed: z.boolean().describe('False when the slide was already in the requested state'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const slideXml = readSlideXml(entries, file);
      const wasHidden = isSlideHidden(slideXml);

      // Rewriting a slide that is already in the requested state would still
      // reserialize the part, changing bytes in the package for no reason.
      if (wasHidden !== params.hidden) {
        writeSlideXml(entries, file, setSlideHidden(slideXml, params.hidden));
      }

      return { slide_number: params.slide_number, hidden: params.hidden, changed: wasHidden !== params.hidden };
    }),
});
