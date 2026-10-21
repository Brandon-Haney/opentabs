import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveFormatText, liveFormatTextOutputSchema } from '../live-edit.js';

const fontColor = z.string().regex(/^(#[0-9a-fA-F]{6}|auto)$/);

export const formatTextLive = defineTool({
  name: 'format_text_live',
  displayName: 'Format Text (Live)',
  description:
    'Set or clear character formatting in the document open in this tab, while it stays open: bold, italic, ' +
    'underline, strikethrough, superscript, subscript, font colour, highlight, size and font, as the Home ribbon ' +
    'sets them. The change appears in every open editor within seconds. Target text with `find` (exact, ' +
    'case-sensitive, within one paragraph; it must occur once unless `all: true`), optionally limited to one ' +
    'paragraph by `anchor` or `index`; or name only a paragraph to format all of its text. Only the fields you pass ' +
    'change, and `false` turns a property off. `clear: true` is Clear Formatting: it removes all character ' +
    'formatting, including link styling on text that only looks like a link. Pass `dry_run: true` to build the ' +
    'edit without writing it.',
  summary: 'Format text in the open document, live',
  icon: 'bold',
  group: 'Live editing',
  input: z.object({
    find: z.string().min(1).optional().describe('The exact text to format (case-sensitive, within one paragraph).'),
    all: z.boolean().optional().describe('Format every occurrence of `find` (default false: it must occur once).'),
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('Text naming the paragraph to format in (or, without `find`, to format whole).'),
    index: z.number().int().min(1).optional().describe('That paragraph’s index from get_live_document.'),
    bold: z.boolean().optional().describe('Bold on or off.'),
    italic: z.boolean().optional().describe('Italic on or off.'),
    underline: z.boolean().optional().describe('Single underline on or off.'),
    strikethrough: z.boolean().optional().describe('Strikethrough on or off.'),
    superscript: z.boolean().optional().describe('Superscript on or off.'),
    subscript: z.boolean().optional().describe('Subscript on or off.'),
    color: fontColor
      .optional()
      .describe('Font colour as #RRGGBB, or "auto" for the automatic colour (black on a light page).'),
    highlight: z
      .string()
      .regex(/^(#[0-9a-fA-F]{6}|none)$/)
      .optional()
      .describe('Highlight colour as #RRGGBB (#FFFF00 is the usual yellow), or "none" to remove the highlight.'),
    size: z.number().min(1).max(1638).optional().describe('Font size in points, e.g. 11 or 10.5.'),
    font: z.string().min(1).optional().describe('Font name, e.g. "Calibri".'),
    clear: z.boolean().optional().describe('Clear all character formatting instead of setting any.'),
    dry_run: z.boolean().optional().describe('Build and return the edit without writing it.'),
  }),
  output: liveFormatTextOutputSchema,
  handle: async params => {
    const { find, all, anchor, index, dry_run, ...format } = params;
    if (anchor !== undefined && index !== undefined) {
      throw ToolError.validation('Pass at most one of `anchor` or `index` to name the paragraph.');
    }
    if (find === undefined && anchor === undefined && index === undefined) {
      throw ToolError.validation('Pass `find` (the text to format), or name a paragraph with `anchor` or `index`.');
    }
    const setsSomething = Object.entries(format).some(([key, value]) => key !== 'clear' && value !== undefined);
    if (format.clear === true && setsSomething) {
      throw ToolError.validation('`clear: true` removes all character formatting; pass it without other changes.');
    }
    return liveFormatText({ find, all: all ?? false, anchor, index }, format, dry_run ?? false);
  },
});
