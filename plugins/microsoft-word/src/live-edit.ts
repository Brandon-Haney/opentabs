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
  dryRun: boolean,
): z.infer<typeof liveInsertParagraphsOutputSchema> =>
  liveAction('word_insert_paragraphs', { ...targetArgs(target), position, paragraphs }, dryRun);

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
