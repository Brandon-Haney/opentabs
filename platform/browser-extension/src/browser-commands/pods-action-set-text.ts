/**
 * Pods `set_text` action — replace a paragraph's text in an OPEN deck, live.
 *
 * Decoded from the editor's own captured `Typing` write, which is far simpler
 * than the formatting revisions: an action descriptor plus the paragraph
 * (`393230`) resubmitted with its full property list, where the text property
 * (`469769250`) carries the paragraph's ENTIRE current text. No run object is
 * written — the run references stay pointed at the existing runs, which keep
 * supplying the formatting. So a text replacement is the proven
 * copy-verbatim-and-patch-one-property shape applied to the paragraph itself.
 *
 * Like `format_text`, this targets a single-run paragraph: multi-run text would
 * need per-range bookkeeping across runs, which the captured single-run write
 * does not exercise.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { type ResolvedTarget, resolveRunFormatTarget } from './pods-action-run-format.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import { CLASS_PARAGRAPH, CLASS_RUN, type PodsModel, PROP_TEXT, readProp } from './pods-model.js';

/** The client sequence hint the captured Typing write carried. Not server-validated. */
const REVISION_SEQUENCE = 37;

/** The validated arguments of a `set_text` action. */
export interface SetTextArgs {
  /** Exact visible text of the target paragraph, as it is now. */
  text: string;
  /** The replacement text. */
  newText: string;
}

/**
 * Build the `Typing` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The paragraph is resubmitted with
 * every property copied verbatim except the text, then sorted ascending by id —
 * matching the editor's own Typing write, whose paragraph carries the full
 * current property list with the new text in `469769250`. The run references
 * (`603987475`, and the end-mark `536886591`) are among the verbatim copies, so
 * the existing run keeps supplying the formatting.
 */
export const buildSetTextBody = (
  target: ResolvedTarget,
  newText: string,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const [run, ...extraRuns] = target.textRuns;
  if (!run || extraRuns.length > 0) {
    throw new FrameBridgeValidationError(
      `set_text replaces single-run text; "${target.paragraphId}" has ${target.textRuns.length} formatting runs. ` +
        'Replacing multi-run text is not supported yet.',
    );
  }

  const newParagraphProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < target.paragraphProperties.length; i += 2) {
    const key = target.paragraphProperties[i];
    const value = target.paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    newParagraphProperties.push(key, key === PROP_TEXT ? newText : value);
  }

  const objects = [
    {
      ObjectId: target.actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780989, 'Typing'],
    },
    { ObjectId: target.paragraphId, ClassId: CLASS_PARAGRAPH, Properties: sortPropertiesById(newParagraphProperties) },
  ];

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: target.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [{ Id: `${guidToken}|3`, Objects: objects }],
    IsFolderCell: false,
  };

  return {
    Mode: 4,
    srs: [
      [
        3,
        {
          OperationId: 1,
          DependentOn: 0,
          Revisions: [revision],
          ExpectedLatestId: headToken,
          Sequence: REVISION_SEQUENCE,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** The target paragraph's current text, read fresh from a model. */
const textOfParagraph = (model: PodsModel, paragraphId: string): string | undefined => {
  const paragraph = model.objects.find(o => o.classId === CLASS_PARAGRAPH && o.objectId === paragraphId);
  return paragraph ? readProp(paragraph.properties, PROP_TEXT) : undefined;
};

/** The `set_text` action: replace the text of the paragraph matched by its current visible text. */
export const setTextAction: PodsWriteActionSpec<SetTextArgs, ResolvedTarget> = {
  kind: 'write',
  classFilter: [CLASS_PARAGRAPH, CLASS_RUN],
  parseArgs: raw => {
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw new FrameBridgeValidationError('set_text needs `text`: the exact current visible text of the paragraph.');
    }
    if (typeof raw.newText !== 'string') {
      throw new FrameBridgeValidationError('set_text needs `newText`: the replacement text.');
    }
    if (raw.newText === raw.text) {
      throw new FrameBridgeValidationError('set_text `newText` is identical to `text` — nothing to change.');
    }
    if (raw.newText.includes('\n')) {
      throw new FrameBridgeValidationError(
        'set_text replaces a single paragraph and cannot insert line breaks yet — pass single-line text.',
      );
    }
    return { text: raw.text, newText: raw.newText };
  },
  resolve: (model, args) => resolveRunFormatTarget(model, args.text),
  build: (ctx, args, mint: PodsMint) => buildSetTextBody(ctx, args.newText, mint.guidToken, mint.headToken),
  // Applied when the SAME paragraph object now carries the new text. Keyed on the
  // paragraph id, not a text search, so an unrelated paragraph that happens to
  // already say `newText` can never confirm this write.
  isApplied: (model, first, args) => textOfParagraph(model, first.paragraphId) === args.newText,
  // Never auto-re-issued: after a successful apply, the old text is gone, so a
  // re-resolve by it would fail; and a genuinely dropped write should be
  // re-attempted deliberately, against a re-read deck, not blindly.
  idempotent: false,
  summarize: (ctx, args) => ({
    text: args.text,
    newText: args.newText,
    paragraphId: ctx.paragraphId,
    runId: ctx.textRuns[0]?.objectId ?? '',
  }),
  dryRunExtras: (ctx, args) => ({
    text: args.text,
    newText: args.newText,
    paragraphId: ctx.paragraphId,
  }),
};
