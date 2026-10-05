/**
 * Word's live document model, read through the pods engine.
 *
 * Word on the web co-authors through the same Cobalt revision protocol as
 * PowerPoint — `{Mode, srs:[[3, {Revision:{ObjectGroups…}}]]}` posted to
 * `/we/OneNote.ashx` in the `wordeditorframe` OOPIF — so the pods engine reads
 * and writes it unchanged: the zero-base read rebuilds the live object graph,
 * and a write is a revision naming the objects it replaces. What differs is the
 * object graph (decoded in `plugins/microsoft-word/docs/live-document-model.md`)
 * and the request envelope, both handled here.
 *
 * The graph, from the root down:
 *
 *   document root (393271) ─603986975→ story (393227)
 *     ─603986976→ section (1073872968) ─603986976→ body containers (393241)
 *     ─603986976→ blocks (393229) ─603986975→ one paragraph (393230) or table (393250)
 *   table ─603986976→ rows (393251) ─603986976→ cells (393252) ─603986976→ blocks
 *
 * A paragraph holds its whole text in `469769250`. Formatting that changes
 * partway through is carried as parallel per-run arrays alongside a run-boundary
 * offset list, so editing text means keeping those arrays consistent with it.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import {
  CLASS_PRESENTATION,
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';

/** The document's main story, the root's only ordered child. */
export const WORD_CLASS_STORY = 393227;
export const WORD_CLASS_SECTION = 1073872968;
/** A run of blocks in document order; a section holds several when a table splits its flow. */
export const WORD_CLASS_BODY = 393241;
/** A block: the wrapper holding exactly one paragraph or table. */
export const WORD_CLASS_BLOCK = 393229;
export const WORD_CLASS_PARAGRAPH = 393230;
export const WORD_CLASS_TABLE = 393250;
export const WORD_CLASS_TABLE_ROW = 393251;
export const WORD_CLASS_TABLE_CELL = 393252;
/** A style definition, named by a paragraph's {@link PROP_PARAGRAPH_STYLE}. */
export const WORD_CLASS_STYLE = 1073872969;

/** Every class the document walk passes through. */
export const WORD_STRUCTURE_CLASSES = [
  CLASS_PRESENTATION,
  WORD_CLASS_STORY,
  WORD_CLASS_SECTION,
  WORD_CLASS_BODY,
  WORD_CLASS_BLOCK,
  WORD_CLASS_PARAGRAPH,
  WORD_CLASS_TABLE,
  WORD_CLASS_TABLE_ROW,
  WORD_CLASS_TABLE_CELL,
];

/** Run-boundary character offsets: `"42,46"` splits a paragraph into three runs. */
export const PROP_RUN_BOUNDARIES = 469769746;
/** Strings holding one character per run (`"111"` for three runs). */
export const RUN_FLAG_PROPS = [469769819, 469777855];
/**
 * Comma-separated lists with one entry per run: the character-format reference
 * (`603987475`) and three companions the editor keeps in step with it.
 */
export const RUN_LIST_PROPS = [603987475, 469777884, 469777513, 469777415];
/** A paragraph's identifiers, unique per paragraph (OOXML `w14:paraId` / `w14:textId`). */
export const PROP_PARA_ID = 335559695;
export const PROP_TEXT_ID = 335559959;
/** The time an object was last changed; the editor stamps it on every object it writes. */
export const PROP_MODIFIED_TIME = 335551866;
export const PROP_PARAGRAPH_STYLE = 536884268;
export const PROP_LIST_ID = 335559682;
export const PROP_LIST_LEVEL = 335559683;
/** A style definition's display name. */
export const PROP_STYLE_NAME = 469775450;
/** Present on a block the editor creates, absent from blocks loaded with the file. */
export const PROP_BLOCK_CREATED = 201333763;

/**
 * Flag asking the Word pre-script to complete a request from the editor's live
 * session — the WOPI `FileId` and Cobalt session identifiers, which exist only
 * inside the editor frame. It must match `WORD_ENVELOPE_FLAG` in
 * `plugins/microsoft-word/src/word-envelope.ts`.
 */
export const WORD_ENVELOPE_FLAG = '__otbWordEnvelope';

const ZERO_REVISION = '00000000-0000-0000-0000-000000000000|0';

/** One paragraph of the document body, in reading order. */
export interface WordParagraph {
  /** 1-based position in reading order, counting paragraphs inside tables. */
  index: number;
  paragraph: PodsObject;
  text: string;
  /** The `{guid}{n}` reference its container lists for the paragraph's block. */
  blockRef: string;
  /** The body container or table cell whose block list holds {@link blockRef}. */
  container: PodsObject;
  inTable: boolean;
}

/** Index a model's objects by id. */
const indexById = (model: PodsModel): Map<string, PodsObject> => new Map(model.objects.map(o => [o.objectId, o]));

/** The objects a property's reference list names, in order, skipping any the model lacks. */
const referenced = (byId: Map<string, PodsObject>, object: PodsObject, prop: number): PodsObject[] =>
  parseRefList(readProp(object.properties, prop) ?? '')
    .map(refToObjectId)
    .map(id => (id ? byId.get(id) : undefined))
    .filter((o): o is PodsObject => o !== undefined);

/**
 * Every paragraph of the document body in reading order, tables included.
 *
 * The walk starts at the root and follows only live references, so a block a
 * revision has unlisted — a deleted paragraph — is never reported even though
 * the latest-wins model still holds its object.
 */
export const listWordParagraphs = (model: PodsModel): WordParagraph[] => {
  const byId = indexById(model);
  const root = findPresentationRoot(model);
  const paragraphs: WordParagraph[] = [];

  const walkContainer = (container: PodsObject, inTable: boolean): void => {
    for (const blockRef of parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '')) {
      const blockId = refToObjectId(blockRef);
      const block = blockId ? byId.get(blockId) : undefined;
      if (!block || block.classId !== WORD_CLASS_BLOCK) continue;
      for (const child of referenced(byId, block, PROP_ORDERED_CHILDREN)) {
        if (child.classId === WORD_CLASS_PARAGRAPH) {
          paragraphs.push({
            index: paragraphs.length + 1,
            paragraph: child,
            text: readProp(child.properties, PROP_TEXT) ?? '',
            blockRef,
            container,
            inTable,
          });
        } else if (child.classId === WORD_CLASS_TABLE) {
          for (const row of referenced(byId, child, PROP_CONTENT_REFS)) {
            for (const cell of referenced(byId, row, PROP_CONTENT_REFS)) walkContainer(cell, true);
          }
        }
      }
    }
  };

  for (const story of referenced(byId, root, PROP_ORDERED_CHILDREN)) {
    if (story.classId !== WORD_CLASS_STORY) continue;
    for (const section of referenced(byId, story, PROP_CONTENT_REFS)) {
      for (const body of referenced(byId, section, PROP_CONTENT_REFS)) {
        if (body.classId === WORD_CLASS_BODY) walkContainer(body, false);
      }
    }
  }
  return paragraphs;
};

/** A short, single-line rendering of a paragraph's text for error messages. */
const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
};

/**
 * The one paragraph `needle` identifies: the paragraph whose text is exactly
 * `needle`, or else the one paragraph containing it. Throws a validation error
 * naming the candidates when it matches none or several, so the caller can pass
 * more of the text instead of guessing.
 */
export const findUniqueParagraph = (paragraphs: WordParagraph[], needle: string, role: string): WordParagraph => {
  const exact = paragraphs.filter(p => p.text === needle);
  const matches = exact.length > 0 ? exact : paragraphs.filter(p => p.text.includes(needle));
  const [only, ...rest] = matches;
  if (!only) {
    throw new FrameBridgeValidationError(`No paragraph contains "${preview(needle)}" (${role}).`);
  }
  if (rest.length > 0) {
    const listed = matches
      .slice(0, 5)
      .map(p => `#${p.index} "${preview(p.text)}"`)
      .join('; ');
    throw new FrameBridgeValidationError(
      `"${preview(needle)}" matches ${matches.length} paragraphs (${role}): ${listed}. ` +
        'Pass more of the paragraph text, or its index from the live read, to pick one.',
    );
  }
  return only;
};

/** The paragraph at a 1-based reading-order index. */
export const paragraphAtIndex = (paragraphs: WordParagraph[], index: number): WordParagraph => {
  const found = paragraphs[index - 1];
  if (!found) {
    throw new FrameBridgeValidationError(
      `Paragraph #${index} is out of range; the document has ${paragraphs.length} paragraph(s).`,
    );
  }
  return found;
};

/** Find the container currently listing `blockRef`, for re-binding a target after the document moved. */
export const findContainerOf = (model: PodsModel, blockRef: string): PodsObject | undefined =>
  listWordParagraphs(model).find(p => p.blockRef === blockRef)?.container;

/** The storage cell an object lives in, falling back to the root's. */
export const wordCellIdOf = (model: PodsModel, object: PodsObject): string => {
  const cellId = object.cellId ?? findPresentationRoot(model).cellId;
  if (!cellId) throw new FrameBridgeValidationError('The live model named no storage cell for the document.');
  return cellId;
};

/** Replace one property's value in place, keeping the editor's property order; appends it when absent. */
export const withProperty = (properties: (string | number)[], id: number, value: string): (string | number)[] => {
  const copied = [...properties];
  for (let i = 0; i + 1 < copied.length; i += 2) {
    if (copied[i] === id) {
      copied[i + 1] = value;
      return copied;
    }
  }
  copied.push(id, value);
  return copied;
};

/** A container's properties with its block list replaced. */
export const withBlockList = (container: PodsObject, blockRefs: string[]): (string | number)[] =>
  withProperty(container.properties, PROP_CONTENT_REFS, blockRefs.join(','));

/** One object of a write: the full property list it is replaced with. */
export interface WordWriteObject {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}

/**
 * Wrap the objects a write replaces in Word's revision envelope.
 *
 * The revision is `${guidToken}|1` and its object group `${guidToken}|2`, so
 * objects a write creates take slots from 3 up. The entry carries
 * {@link WORD_ENVELOPE_FLAG} instead of the WOPI `FileId` and Cobalt session
 * identifiers, which the Word pre-script fills in inside the editor frame.
 */
export const buildWordRevisionBody = (
  objects: WordWriteObject[],
  cellId: string,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => ({
  Mode: 2,
  srs: [
    [
      3,
      {
        OperationId: 1,
        DependentOn: 0,
        [WORD_ENVELOPE_FLAG]: true,
        Revision: {
          Id: `${guidToken}|1`,
          RelativePath: null,
          CellId: cellId,
          ContextId: ZERO_REVISION,
          ExpectedLatestId: headToken,
          BaseId: headToken,
          RootObjectDescriptors: null,
          ObjectGroups: [{ Id: `${guidToken}|2`, Objects: objects }],
          IsFolderCell: false,
        },
        BaseRevision: null,
        ExpectedLatestId: headToken,
        ExpectedIncrementalActionId: ZERO_REVISION,
        IsVersionHistoryEnabled: false,
        ClientKnowledge: '',
        EncryptionSessionString: null,
        ShouldSendUpdateNotificationOnSuccess: false,
        ChangeStateList: [],
        MergePromptStatus: 300,
        ShouldPinRevisionForAugLoop: false,
        UsingLayoutResults: 0,
        VectorClockClientId: null,
        VectorClockValue: null,
      },
    ],
  ],
});

/** The text of a paragraph object, read fresh from a model by id. */
export const wordParagraphText = (model: PodsModel, paragraphId: string): string | undefined => {
  const paragraph = model.objects.find(o => o.objectId === paragraphId);
  return paragraph ? (readProp(paragraph.properties, PROP_TEXT) ?? '') : undefined;
};
