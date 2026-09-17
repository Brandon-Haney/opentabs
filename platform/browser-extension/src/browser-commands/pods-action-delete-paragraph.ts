/**
 * Pods `delete_paragraph` action — remove a paragraph from a shape or table cell
 * in an OPEN deck, live.
 *
 * Decoded from the editor's `DeleteKey` on the test deck (2026-09-17): removing
 * whole paragraphs resubmits the container with their blocks dropped from its
 * block list (`603986976`). The removed blocks are not deleted objects, only no
 * longer listed — the same way a block replacement retires the old block. The
 * same write also merged the following paragraph into the preceding one because
 * the selection reached across its end; this action removes exactly one block
 * and leaves its neighbours untouched.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import {
  actionDescIdOf,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  PROP_CONTENT_REFS,
  parseRefList,
  readProp,
} from './pods-model.js';
import { copyWith, locateTextBlock, TEXT_BLOCK_CLASSES, type TextBlockLocation } from './pods-text-block.js';

/** The client sequence hint the captured DeleteKey carried. Not server-validated. */
const REVISION_SEQUENCE = 26;

/** The validated arguments of a `delete_paragraph` action. */
export interface DeleteParagraphArgs {
  /** Exact visible text of the paragraph to remove. */
  text: string;
}

/** The live objects a `delete_paragraph` write needs. */
export interface DeleteParagraphContext extends TextBlockLocation {
  cellId: string;
  actionDescId: string;
}

/** Find the paragraph and the block to drop, refusing removals that would take more than it. */
export const resolveDeleteParagraphContext = (model: PodsModel, text: string): DeleteParagraphContext => {
  const root = findPresentationRoot(model);
  const location = locateTextBlock(model, text);
  if (location.blockParagraphRefs.length > 1) {
    throw new FrameBridgeValidationError(
      `"${text}" shares its text block with ${location.blockParagraphRefs.length - 1} other paragraph(s), so ` +
        'removing its block would remove them too.',
    );
  }
  if (location.contentRefTokens.length <= 1) {
    throw new FrameBridgeValidationError(
      `"${text}" is the only paragraph in its shape or cell. Replace its text with set_text instead of deleting it.`,
    );
  }
  return {
    ...location,
    cellId: location.paragraphCellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
  };
};

/** Build the `DeleteKey` body: the container resubmitted without the paragraph's block. */
export const buildDeleteParagraphBody = (
  ctx: DeleteParagraphContext,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  const blockRefs = ctx.contentRefTokens.filter(ref => ref !== ctx.blockRef);
  return {
    Mode: 4,
    srs: [
      [
        3,
        {
          OperationId: 1,
          DependentOn: 0,
          Revisions: [
            {
              Id: `${guidToken}|1`,
              FileId: null,
              RelativePath: null,
              CellId: ctx.cellId,
              ContextId: '00000000-0000-0000-0000-000000000000|0',
              ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
              BaseId: headToken,
              RootObjectDescriptors: null,
              ObjectGroups: [
                {
                  Id: `${guidToken}|2`,
                  Objects: [
                    {
                      ObjectId: ctx.actionDescId,
                      ClassId: 131140,
                      Properties: [
                        134236193,
                        'true',
                        335562934,
                        '1',
                        469780658,
                        actionDescriptorJson,
                        469780989,
                        'DeleteKey',
                      ],
                    },
                    {
                      ObjectId: ctx.containerObjectId,
                      ClassId: ctx.containerClassId,
                      Properties: copyWith(
                        ctx.containerProperties,
                        new Map([[PROP_CONTENT_REFS, blockRefs.join(',')]]),
                      ),
                    },
                  ],
                },
              ],
              IsFolderCell: false,
            },
          ],
          ExpectedLatestId: headToken,
          Sequence: REVISION_SEQUENCE,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** The `delete_paragraph` action: remove the paragraph whose visible text is `text`. */
export const deleteParagraphAction: PodsWriteActionSpec<DeleteParagraphArgs, DeleteParagraphContext> = {
  kind: 'write',
  classFilter: TEXT_BLOCK_CLASSES,
  parseArgs: raw => {
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw new FrameBridgeValidationError('delete_paragraph needs `text`: the exact visible text of the paragraph.');
    }
    return { text: raw.text };
  },
  resolve: (model, args) => resolveDeleteParagraphContext(model, args.text),
  build: (ctx, _args, mint: PodsMint) =>
    buildDeleteParagraphBody(
      ctx,
      mint.guidToken,
      mint.headToken,
      JSON.stringify({ ActionId: mint.seed, ActionName: 'DeleteKey', ActionTime: mint.actionTime }),
    ),
  // Applied when the container no longer lists the block — keyed on the block's
  // identity, so a paragraph elsewhere with the same text cannot confirm it.
  isApplied: (model, first) => {
    const container = model.objects.find(o => o.objectId === first.containerObjectId);
    return (
      container !== undefined &&
      !parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '').includes(first.blockRef)
    );
  },
  // Never re-issued blindly: once applied, the paragraph is gone and a re-resolve by its text could
  // match a different paragraph that says the same thing.
  idempotent: false,
  summarize: (ctx, args) => ({
    text: args.text,
    paragraphId: ctx.paragraphId,
    blocksBefore: ctx.contentRefTokens.length,
  }),
  dryRunExtras: (ctx, args) => ({ text: args.text, paragraphId: ctx.paragraphId }),
};
