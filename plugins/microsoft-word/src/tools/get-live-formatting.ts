import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveFormattingOutputSchema, readLiveFormatting } from '../live-edit.js';

export const getLiveFormatting = defineTool({
  name: 'get_live_formatting',
  displayName: 'Get Live Formatting',
  description:
    'Read how the paragraphs of the document open in this tab are formatted right now: each paragraph with its ' +
    'style, alignment, indent, spacing, line spacing, shading and list level, and its text split into runs with ' +
    'their bold, italic, underline, strikethrough, colour, highlight, size, font, character style and link address. ' +
    'Only what a paragraph or run sets itself is listed; what it inherits from its style is not. Use it to check ' +
    'formatting before changing it with format_text_live or format_paragraph_live, and to confirm the result. Pass ' +
    '`from` and `to` (indexes from get_live_document) to read part of a long document; one read returns at most 200 ' +
    'paragraphs.',
  summary: 'Read the formatting of the open document',
  icon: 'scan-text',
  group: 'Live editing',
  input: z.object({
    from: z.number().int().min(1).optional().describe('First paragraph index to read (default 1).'),
    to: z.number().int().min(1).optional().describe('Last paragraph index to read (default: the end).'),
  }),
  output: liveFormattingOutputSchema,
  handle: async params => readLiveFormatting({ from: params.from, to: params.to }),
});
