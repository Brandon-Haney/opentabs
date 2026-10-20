import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveFormatParagraph, liveFormatParagraphOutputSchema } from '../live-edit.js';

export const formatParagraphLive = defineTool({
  name: 'format_paragraph_live',
  displayName: 'Format Paragraph (Live)',
  description:
    'Set the alignment, left indent, spacing, line spacing, shading, style or page-flow options (keep with next, ' +
    'keep lines together, page break before) of one paragraph of the document open in this tab, while it stays ' +
    'open; the change appears in every open editor within seconds. Keep with next on a heading stops it being ' +
    'left alone at the bottom of a page. Name the paragraph ' +
    'by `anchor` (its exact text, or text found in no other paragraph) or by its `index` from get_live_document. ' +
    'Only the fields you pass change. `style` applies a paragraph style the document already uses, such as ' +
    '"Normal" or "heading 1"; as in Word, it replaces the paragraph’s own formatting and clears its character ' +
    'formatting. Pass `dry_run: true` to build the edit without writing it.',
  summary: 'Format a paragraph of the open document, live',
  icon: 'pilcrow',
  group: 'Live editing',
  input: z.object({
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('Text naming the paragraph: its exact text, or text found in no other paragraph.'),
    index: z.number().int().min(1).optional().describe('The paragraph’s index from get_live_document.'),
    alignment: z.enum(['left', 'center', 'right', 'justify']).optional().describe('Paragraph alignment.'),
    indent_left: z.number().min(0).max(1584).optional().describe('Left indent in points (36 is half an inch).'),
    space_before: z.number().min(0).max(1584).optional().describe('Space before the paragraph, in points.'),
    space_after: z.number().min(0).max(1584).optional().describe('Space after the paragraph, in points.'),
    line_spacing: z.number().min(0.5).max(10).optional().describe('Line spacing as a multiple: 1, 1.15, 1.5, 2.'),
    shading: z
      .string()
      .regex(/^(#[0-9a-fA-F]{6}|none)$/)
      .optional()
      .describe('Background shading as #RRGGBB, or "none" to remove it.'),
    style: z.string().min(1).optional().describe('A paragraph style already in the document, e.g. "heading 1".'),
    keep_with_next: z.boolean().optional().describe('Keep the paragraph on the same page as the next one.'),
    keep_lines_together: z.boolean().optional().describe('Keep all of the paragraph’s lines on one page.'),
    page_break_before: z.boolean().optional().describe('Start the paragraph on a new page.'),
    dry_run: z.boolean().optional().describe('Build and return the edit without writing it.'),
  }),
  output: liveFormatParagraphOutputSchema,
  handle: async params => {
    if ((params.anchor === undefined) === (params.index === undefined)) {
      throw ToolError.validation('Pass exactly one of `anchor` or `index` to name the paragraph.');
    }
    return liveFormatParagraph(
      { anchor: params.anchor, index: params.index },
      {
        alignment: params.alignment,
        indentLeft: params.indent_left,
        spaceBefore: params.space_before,
        spaceAfter: params.space_after,
        lineSpacing: params.line_spacing,
        shading: params.shading,
        style: params.style,
        keepWithNext: params.keep_with_next,
        keepLinesTogether: params.keep_lines_together,
        pageBreakBefore: params.page_break_before,
      },
      params.dry_run ?? false,
    );
  },
});
