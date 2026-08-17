/**
 * Pods `align_text` action — horizontal paragraph alignment, live.
 *
 * Decoded from the editor's own `CenterTextJustify`/`RightTextJustify` captures:
 * alignment is a PARAGRAPH property pair, not a run property and not a
 * structural action. The paragraph (`393230`) is resubmitted as a verbatim copy
 * with `335551550` and `335551620` both set to the alignment code (1 = left,
 * 2 = center, 3 = right, 4 = justify) — appended when the paragraph never
 * carried them (an inherited-alignment paragraph). No run is written and the
 * run-reference list is untouched, so no paragraph/run divergence can arise
 * (the failure mode that made set_text sync run text). The smallest write in
 * the catalog (~1.5 KB).
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  PROP_TEXT,
  readProp,
} from './pods-model.js';

/** Paragraph (393230) alignment property ids — always written as a pair with the same code. */
const PROP_ALIGN_A = 335551550;
const PROP_ALIGN_B = 335551620;

/** Alignment name → wire code, and the editor's own action name for each. */
const ALIGNMENTS = {
  left: { code: '1', actionName: 'LeftTextJustify' },
  center: { code: '2', actionName: 'CenterTextJustify' },
  right: { code: '3', actionName: 'RightTextJustify' },
  justify: { code: '4', actionName: 'JustifyTextJustify' },
} as const;

export type TextAlignment = keyof typeof ALIGNMENTS;

/** Wire code → alignment name, for before-state reporting. */
const alignmentOfCode = (code: string | undefined): TextAlignment | null => {
  for (const [name, spec] of Object.entries(ALIGNMENTS)) {
    if (spec.code === code) return name as TextAlignment;
  }
  return null;
};

/** The validated arguments of an `align_text` action. */
export interface AlignTextArgs {
  /** Exact visible text of the target paragraph. */
  text: string;
  alignment: TextAlignment;
}

/** The live objects an `align_text` write needs, resolved from the model. */
export interface AlignTextContext {
  /** The target paragraph's storage cell id. */
  cellId: string;
  /** The action descriptor id (`<presentation action-context guid>|1`). */
  actionDescId: string;
  paragraphId: string;
  /** The paragraph's full property list, copied so the resubmit changes only the alignment pair. */
  paragraphProperties: (string | number)[];
  /** The alignment before the change, null when the paragraph inherited it. */
  alignmentBefore: TextAlignment | null;
}

/**
 * Find the paragraph whose visible text matches exactly. Errors name nearby text
 * so a near-miss is a one-step fix rather than a guessing game.
 */
export const resolveAlignTextContext = (model: PodsModel, text: string): AlignTextContext => {
  const root = findPresentationRoot(model);
  const paragraph = model.objects.find(
    o => o.classId === CLASS_PARAGRAPH && readProp(o.properties, PROP_TEXT) === text,
  );
  if (!paragraph) {
    const samples = model.objects
      .filter(o => o.classId === CLASS_PARAGRAPH)
      .map(o => readProp(o.properties, PROP_TEXT))
      .filter((t): t is string => Boolean(t))
      .slice(0, 12);
    throw new FrameBridgeValidationError(
      `No text on the slide exactly matches "${text}". Nearby text: ${samples.map(t => `"${t}"`).join(', ')}`,
    );
  }
  return {
    cellId: paragraph.cellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    paragraphId: paragraph.objectId,
    paragraphProperties: paragraph.properties,
    alignmentBefore: alignmentOfCode(readProp(paragraph.properties, PROP_ALIGN_A)),
  };
};

/**
 * Build the alignment revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The paragraph is a verbatim copy with
 * only the alignment pair overridden (appended when absent), sorted ascending to
 * match the editor's own write. No run object and no run-reference rewrite.
 */
export const buildAlignTextBody = (
  ctx: AlignTextContext,
  alignment: TextAlignment,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  const { code, actionName } = ALIGNMENTS[alignment];

  const seen = new Set<number>();
  const copied: (string | number)[] = [];
  for (let i = 0; i + 1 < ctx.paragraphProperties.length; i += 2) {
    const key = ctx.paragraphProperties[i];
    const value = ctx.paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (typeof key === 'number') seen.add(key);
    copied.push(key, key === PROP_ALIGN_A || key === PROP_ALIGN_B ? code : value);
  }
  for (const propId of [PROP_ALIGN_A, PROP_ALIGN_B]) {
    if (!seen.has(propId)) copied.push(propId, code);
  }
  const newParagraphProperties = sortPropertiesById(copied);

  const objects = [
    {
      ObjectId: ctx.actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, actionName],
    },
    { ObjectId: ctx.paragraphId, ClassId: CLASS_PARAGRAPH, Properties: newParagraphProperties },
  ];

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
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
          Sequence: 30,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** The `align_text` action: set the horizontal alignment of the paragraph matched by visible text. */
export const alignTextAction: PodsWriteActionSpec<AlignTextArgs, AlignTextContext> = {
  kind: 'write',
  classFilter: [CLASS_PARAGRAPH],
  parseArgs: raw => {
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw new FrameBridgeValidationError('align_text needs `text`: the exact visible text of the target paragraph.');
    }
    if (typeof raw.alignment !== 'string' || !(raw.alignment in ALIGNMENTS)) {
      throw new FrameBridgeValidationError('align_text needs `alignment`: one of left, center, right, justify.');
    }
    return { text: raw.text, alignment: raw.alignment as TextAlignment };
  },
  resolve: (model, args) => resolveAlignTextContext(model, args.text),
  build: (ctx, args, mint: PodsMint) => {
    const seedHex = mint.seed.replace(/-/g, '').slice(0, 8);
    const actionDescriptorJson = JSON.stringify({
      ActionId: String((Number.parseInt(seedHex, 16) || 0) >>> 0),
      ActionName: ALIGNMENTS[args.alignment].actionName,
      ActionTime: mint.actionTime,
    });
    return buildAlignTextBody(ctx, args.alignment, mint.guidToken, mint.headToken, actionDescriptorJson);
  },
  // Applied when the paragraph carries the requested alignment code. The
  // paragraph is re-found by text — its object id survives an alignment write.
  isApplied: (model, _first, args) => {
    try {
      const state = resolveAlignTextContext(model, args.text);
      return readProp(state.paragraphProperties, PROP_ALIGN_A) === ALIGNMENTS[args.alignment].code;
    } catch {
      return false;
    }
  },
  // Re-setting the same alignment is a harmless overwrite.
  idempotent: true,
  summarize: (ctx, args) => ({
    text: args.text,
    paragraphId: ctx.paragraphId,
    alignment: args.alignment,
    alignmentBefore: ctx.alignmentBefore,
  }),
};
