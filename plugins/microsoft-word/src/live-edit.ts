import { z } from 'zod';

/**
 * Editing an OPEN document goes through Word's co-authoring channel — an
 * incremental revision POSTed to `/we/OneNote.ashx` inside the cross-origin
 * `wordeditorframe` frame. Graph's full-file PUT is refused with HTTP 423 while
 * the document is open in the web editor, so this is the only path that can
 * change it mid-session, and its edits appear in every open editor live.
 *
 * A tool cannot make the call itself: the adapter runs in the SharePoint host
 * page and the endpoint is same-origin only to the editor frame. A tool instead
 * returns a `__podsAction` directive naming a registered action and its
 * arguments; the platform's pods engine reads the live document in the editor
 * frame, resolves the target, builds the revision, writes it with the frame's own
 * session, and confirms it applied. The handler never sees the response — the
 * platform replaces the directive with the engine's result.
 *
 * The request envelope needs the document's WOPI `FileId` and the editor's
 * Cobalt session identifiers, which exist only in the frame. The engine's
 * requests carry a flag instead, and this plugin's pre-script completes them
 * from the editor's latest request inside the frame (see `pre-script.ts`).
 */

/** Substring selecting Word's editor frame; its sibling `officeapps` frames hold no session. */
const FRAME_URL_INCLUDES = 'wordeditorframe';
/** Frame global the pre-script stashes the editor's freshest channel request into. */
const DONOR_GLOBAL = '__otbWordDonor';
/** URL marker the pre-script answers in-frame with the current co-authoring head. */
const HEAD_SENTINEL = '__otb_word_head__';
/** The `__podsAction` contract version this plugin is built against. */
const PODS_ACTION_VERSION = 1;
/** Placeholders the engine substitutes at write time with a fresh GUID and the current head. */
const GUID_TOKEN = '__OTB_PODS_GUID__';
const HEAD_TOKEN = '__OTB_PODS_HEAD__';

/**
 * The live-document read: the editor's own poll, asked from the zero base. The
 * server answers with every revision since the document loaded — the whole
 * current document — rather than the delta the editor's poll would get. The
 * pre-script fills in everything else from the editor's latest poll.
 */
const MODEL_READ_BODY = JSON.stringify({
  Mode: 2,
  srs: [
    [
      2,
      {
        OperationId: 1,
        DependentOn: 0,
        __otbWordEnvelope: true,
        ExpectedLatestRevisionId: '00000000-0000-0000-0000-000000000000|0',
      },
    ],
  ],
});

/** Guidance the engine appends to a failed write, keyed on the co-authoring failure codes. */
const ERROR_HINTS: Record<string, string> = {
  'se:157/2':
    'The document moved on while the edit was being written (the engine already retried with a fresh base). ' +
    'If it persists, reload the document tab and retry.',
  'se:223/3': "The editor's session was stale. Reload the document tab so the editor starts a fresh one, then retry.",
};

/**
 * Build a `__podsAction` directive. The return is typed as what the agent
 * receives — the engine's result, which the platform puts in the directive's
 * place — a transform the type system cannot otherwise express, so the cast
 * lives here alone.
 */
const liveAction = <TOutput>(action: string, args: Record<string, unknown>, dryRun = false): TOutput =>
  ({
    __podsAction: {
      v: PODS_ACTION_VERSION,
      action,
      args,
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      modelReadBody: MODEL_READ_BODY,
      dryRun,
      guidToken: GUID_TOKEN,
      headToken: HEAD_TOKEN,
      errorHints: ERROR_HINTS,
    },
  }) as unknown as TOutput;

/** The result fields every confirmed live write shares. */
const liveWriteResultShape = {
  action: z.string().optional().describe('The engine action that ran.'),
  applied: z
    .boolean()
    .optional()
    .describe('Whether the change was observed in the live document after the write — the proof it landed.'),
  retries: z.number().int().optional().describe('Extra attempts a concurrent edit by someone else cost.'),
  dryRun: z.boolean().optional().describe('True when the revision was built but not written.'),
  body: z.unknown().optional().describe('The revision that would have been written (dry run only).'),
};

/** A paragraph as the live read reports it. */
const liveParagraphSchema = z.object({
  index: z.number().int().describe('1-based position in reading order, counting paragraphs inside tables.'),
  text: z.string().describe('The paragraph text.'),
  style: z.string().nullable().describe('The paragraph style name (e.g. "heading 1"), when it names one.'),
  listLevel: z.number().int().nullable().describe('List nesting level (0 = top) for a list item, else null.'),
  inTable: z.boolean().describe('Whether the paragraph is inside a table cell.'),
});

export const liveDocumentOutputSchema = z.object({
  paragraphs: z.array(liveParagraphSchema).describe('The document body, in reading order.'),
  totalParagraphs: z.number().int().describe('Paragraphs in the document body.'),
  truncated: z.boolean().describe('Whether the paragraph list was capped.'),
});

/** Read the open document's paragraphs as they are in the editor right now. */
export const readLiveDocument = (): z.infer<typeof liveDocumentOutputSchema> => liveAction('word_read', {});

export const liveReplaceTextOutputSchema = z.object({
  ...liveWriteResultShape,
  find: z.string().optional().describe('The text that was replaced.'),
  replace: z.string().optional().describe('The text it was replaced with.'),
  replacements: z.number().int().optional().describe('How many occurrences were replaced.'),
  paragraphs: z
    .array(z.object({ index: z.number().int(), text: z.string() }))
    .optional()
    .describe('Each changed paragraph and its new text.'),
});

/** Replace text in the open document, keeping each paragraph's formatting. */
export const liveReplaceText = (
  find: string,
  replace: string,
  all: boolean,
  dryRun: boolean,
): z.infer<typeof liveReplaceTextOutputSchema> => liveAction('word_replace_text', { find, replace, all }, dryRun);

/** Which paragraph an insert or delete is about: text identifying it, or its index from the live read. */
export interface ParagraphTarget {
  anchor?: string;
  index?: number;
}

const targetArgs = (target: ParagraphTarget): Record<string, unknown> =>
  target.index !== undefined ? { index: target.index } : { anchor: target.anchor };

export const liveInsertParagraphsOutputSchema = z.object({
  ...liveWriteResultShape,
  anchorIndex: z.number().int().optional().describe('The index of the paragraph the new ones were placed beside.'),
  anchorText: z.string().optional().describe('The text of that paragraph.'),
  position: z.enum(['before', 'after']).optional().describe('Which side of it they went.'),
  inserted: z.number().int().optional().describe('How many paragraphs were inserted.'),
});

/** Insert paragraphs before or after a paragraph of the open document. */
export const liveInsertParagraphs = (
  target: ParagraphTarget,
  position: 'before' | 'after',
  paragraphs: string[],
  formatLike: number | undefined,
  dryRun: boolean,
): z.infer<typeof liveInsertParagraphsOutputSchema> =>
  liveAction(
    'word_insert_paragraphs',
    { ...targetArgs(target), position, paragraphs, format_like: formatLike },
    dryRun,
  );

export const liveDeleteParagraphOutputSchema = z.object({
  ...liveWriteResultShape,
  deletedIndex: z.number().int().optional().describe('The index the deleted paragraph had.'),
  deletedText: z.string().optional().describe('The text the deleted paragraph had.'),
});

/** Delete one paragraph of the open document. */
export const liveDeleteParagraph = (
  target: ParagraphTarget,
  dryRun: boolean,
): z.infer<typeof liveDeleteParagraphOutputSchema> => liveAction('word_delete_paragraph', targetArgs(target), dryRun);

/** Character formatting a live format sets; a field left out is left as it is. */
export interface LiveCharacterFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** `#RRGGBB`. */
  color?: string;
  /** `#RRGGBB`. */
  highlight?: string;
  /** Points. */
  size?: number;
  font?: string;
  /** Clear all character formatting instead of setting any. */
  clear?: boolean;
}

export const liveFormatTextOutputSchema = z.object({
  ...liveWriteResultShape,
  formatted: z.number().int().optional().describe('How many stretches of text were formatted.'),
  cleared: z.boolean().optional().describe('Whether the formatting was cleared rather than set.'),
  paragraphs: z
    .array(z.object({ index: z.number().int(), text: z.string() }))
    .optional()
    .describe('Each paragraph that was formatted.'),
});

/** Set or clear character formatting on matched text, or on a whole paragraph, in the open document. */
export const liveFormatText = (
  target: { find?: string; all: boolean } & ParagraphTarget,
  format: LiveCharacterFormat,
  dryRun: boolean,
): z.infer<typeof liveFormatTextOutputSchema> => liveAction('word_format_text', { ...target, ...format }, dryRun);

/** Paragraph formatting a live format sets; a field left out is left as it is. */
export interface LiveParagraphFormat {
  alignment?: 'left' | 'center' | 'right' | 'justify';
  /** Points. */
  indentLeft?: number;
  /** Points. */
  spaceBefore?: number;
  /** Points. */
  spaceAfter?: number;
  /** A multiple of single spacing. */
  lineSpacing?: number;
  /** `#RRGGBB`, or `none`. */
  shading?: string;
  style?: string;
  keepWithNext?: boolean;
  keepLinesTogether?: boolean;
  pageBreakBefore?: boolean;
}

export const liveFormatParagraphOutputSchema = z.object({
  ...liveWriteResultShape,
  index: z.number().int().optional().describe('The index of the paragraph that was formatted.'),
  text: z.string().optional().describe('Its text.'),
});

/** Set the alignment, indent, spacing, shading or style of one paragraph of the open document. */
export const liveFormatParagraph = (
  target: ParagraphTarget,
  format: LiveParagraphFormat,
  dryRun: boolean,
): z.infer<typeof liveFormatParagraphOutputSchema> =>
  liveAction('word_format_paragraph', { ...targetArgs(target), ...format }, dryRun);

const liveRunSchema = z.object({
  text: z.string().describe('The run text.'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  superscript: z.boolean().optional(),
  subscript: z.boolean().optional(),
  color: z.string().optional().describe('Font colour as #RRGGBB, or auto for the automatic colour.'),
  highlight: z.string().optional().describe('Highlight colour as #RRGGBB.'),
  size: z.number().optional().describe('Font size in points.'),
  font: z.string().optional().describe('Font name.'),
  characterStyle: z.string().optional().describe('The character style the run names, e.g. "Hyperlink".'),
  link: z.string().optional().describe('The address, when the run is the text of a link.'),
});

const liveParagraphFormattingSchema = z.object({
  index: z.number().int().describe('1-based position in reading order, as get_live_document reports it.'),
  text: z.string().describe('The paragraph text.'),
  style: z.string().nullable().describe('The paragraph style name, or null when it names none.'),
  alignment: z.string().optional().describe('center, right or justify; absent means it follows its style.'),
  indentLeft: z.number().optional().describe('Left indent in points.'),
  spaceBefore: z.number().optional().describe('Space before, in points.'),
  spaceAfter: z.number().optional().describe('Space after, in points.'),
  lineSpacing: z.number().optional().describe('Line spacing as a multiple.'),
  shading: z.string().optional().describe('Background shading as #RRGGBB.'),
  listLevel: z.number().int().optional().describe('List level (0 = top) when the paragraph is a Word list item.'),
  keepWithNext: z.boolean().optional().describe('Kept on the same page as the next paragraph.'),
  keepLinesTogether: z.boolean().optional().describe('Its lines kept on one page.'),
  pageBreakBefore: z.boolean().optional().describe('Starts on a new page.'),
  runs: z.array(liveRunSchema).describe('The text in runs of identical formatting, links marked with their address.'),
});

export const liveFormattingOutputSchema = z.object({
  paragraphs: z.array(liveParagraphFormattingSchema).describe('The requested paragraphs, in reading order.'),
  totalParagraphs: z.number().int().describe('Paragraphs in the document body.'),
  truncated: z.boolean().describe('Whether the paragraph list was capped (at most 200 per read).'),
});

export const liveRemoveLinkOutputSchema = z.object({
  ...liveWriteResultShape,
  removed: z
    .array(
      z.object({
        index: z.number().int().describe('The paragraph the link was in.'),
        address: z.string().describe('The address it pointed at.'),
        text: z.string().describe('The text it displayed, which stays.'),
      }),
    )
    .optional()
    .describe('Each link removed.'),
});

/** Remove hyperlinks from the open document, keeping their text. */
export const liveRemoveLink = (
  target: { find?: string } & ParagraphTarget,
  dryRun: boolean,
): z.infer<typeof liveRemoveLinkOutputSchema> => liveAction('word_remove_link', { ...target }, dryRun);

/** Read the formatting of the open document's paragraphs, `from` through `to`. */
export const readLiveFormatting = (range: { from?: number; to?: number }): z.infer<typeof liveFormattingOutputSchema> =>
  liveAction('word_read_formatting', range);
