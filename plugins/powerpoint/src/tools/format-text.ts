import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsFormatText, podsFormatTextOutputSchema } from '../pods-bridge.js';

export const formatText = defineTool({
  name: 'format_text',
  displayName: 'Format Text',
  description:
    'Change the formatting of text on the open slide — font size, bold, italic, underline, color, and/or font ' +
    'family. Name the paragraph with `text`, and optionally narrow the change to part of it with `match`, the ' +
    'way a person selects a few words before clicking Bold; without `match` the whole paragraph changes. Text ' +
    'outside the match keeps the formatting it had, and a match spanning differently formatted words keeps each ' +
    'of their fonts and colors while applying what you asked for. This writes into the live co-authoring ' +
    'session, so the change appears in the open editor within a few seconds; it edits the deck in place while ' +
    'it is open (Graph refuses writes under the co-authoring lock). Pass at least one formatting field. Use ' +
    '`get_live_outline` to see the exact paragraph text. The deck must be open and active in the browser.',
  summary: 'Format slide text, or part of it, by its content',
  icon: 'type',
  group: 'Slides',
  input: z
    .object({
      text: z
        .string()
        .min(1)
        .describe('The exact visible text of the paragraph to format, e.g. "Workstream" or a slide title.'),
      match: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Format only this part of the paragraph — a substring of `text`, e.g. "Q3" to bold one word of a sentence. Omit to format the whole paragraph.',
        ),
      occurrence: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Which occurrence of `match` to format when it appears more than once, counting from 1. Defaults to the first.',
        ),
      size_pt: z.number().positive().optional().describe('New font size in points.'),
      bold: z.boolean().optional().describe('Set bold on or off.'),
      italic: z.boolean().optional().describe('Set italic on or off.'),
      underline: z.boolean().optional().describe('Set underline on or off.'),
      color: z
        .string()
        .regex(/^#?[0-9a-fA-F]{6}$/, 'Color must be a 6-digit hex like "FF0000" or "#FF0000".')
        .optional()
        .describe('New font color as 6-digit hex RRGGBB (e.g. "FF0000").'),
      font: z.string().min(1).optional().describe('New font family name, e.g. "Georgia".'),
    })
    .refine(
      input =>
        input.size_pt !== undefined ||
        input.bold !== undefined ||
        input.italic !== undefined ||
        input.underline !== undefined ||
        input.color !== undefined ||
        input.font !== undefined,
      { message: 'Provide at least one formatting field to change.' },
    ),
  output: podsFormatTextOutputSchema,
  handle: async params =>
    podsFormatText(
      params.text,
      {
        sizePt: params.size_pt,
        bold: params.bold,
        italic: params.italic,
        underline: params.underline,
        colorHex: params.color?.replace('#', '').toUpperCase(),
        font: params.font,
      },
      { match: params.match, occurrence: params.occurrence },
    ),
});
