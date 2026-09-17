/**
 * Pods `add_table_row` action — insert a row into a table in an OPEN deck, live.
 *
 * Decoded from the editor's `InsertRowBelow` (Table Layout → Insert Below) on the
 * test deck, 2026-09-17. It is one revision:
 *
 * - the table (`393250`) with the new row's reference inserted after the source
 *   row in its row list (`603986976`) and its row count (`335551831`) raised by one;
 * - the new row (`393251`), a copy of the source row with fresh row identities
 *   (`469780485`, `469780523`) and one cell reference per column;
 * - for each column, a cell (`393252`) copied from the source row's cell — borders,
 *   fill, margins — carrying the new row id, and a new block in that cell holding
 *   one paragraph formatted like the cell above's text.
 *
 * Row and column ids are 8 hex digits padded with zero groups
 * (`33f26867-0000-0000-0000-000000000000`); a cell's block carries both its row
 * and column id on its text body and its paragraph.
 *
 * The editor inserts empty cells and types afterwards; a cell born carrying text
 * is the same object graph with the text set, as `set_text`'s block replacement
 * writes it.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { typingParagraphAndRun } from './pods-action-set-text.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  CLASS_RUN,
  CLASS_TEXT_BODY,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  PROP_RUN_REF,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';
import {
  type BlockSource,
  blockParagraphText,
  buildNewBlock,
  CLASS_LIST_MARKER,
  CLASS_TABLE,
  CLASS_TABLE_CELL,
  CLASS_TABLE_ROW,
  copyWith,
  locateTextBlock,
  PROP_END_OF_PARAGRAPH_FORMATTING,
  PROP_LAST_MODIFIED_TIME,
  PROP_LIST_MARKER_REF,
  TEXT_BLOCK_CLASSES,
} from './pods-text-block.js';

/** The table's row count. */
const PROP_ROW_COUNT = 335551831;
/** A row's id, carried by the row, its cells, and each cell's text body and paragraph. */
const PROP_ROW_ID = 469780485;
/** A column's id, carried by each cell of that column and the cell's text body and paragraph. */
const PROP_COLUMN_ID = 469780486;
/** A second per-row identity, fresh on every row the editor inserts. */
const PROP_ROW_UNIQUE_ID = 469780523;

/** Object slots minted under the write GUID. Each cell takes a band of five: cell, text body, paragraph, list marker, run. */
const SLOT_REVISION = 1;
const SLOT_GROUP = 2;
const SLOT_ROW = 3;
const FIRST_CELL_SLOT = 10;
const SLOTS_PER_CELL = 5;

/** The client sequence hint the captured InsertRowBelow carried. Not server-validated. */
const REVISION_SEQUENCE = 21;

/** The validated arguments of an `add_table_row` action. */
export interface AddTableRowArgs {
  /** Exact visible text of a paragraph in any cell of the row to insert below. */
  after: string;
  /** Text for the new row's cells, left to right; missing entries leave a cell empty. */
  cells: string[];
}

/** One cell of the source row, and what its new counterpart copies. */
export interface SourceCell {
  cell: PodsObject;
  /** The formatting source for the new cell's paragraph. */
  paragraph: BlockSource;
}

/** The live objects an `add_table_row` write needs, resolved from the model. */
export interface AddTableRowContext {
  cellId: string;
  actionDescId: string;
  table: PodsObject;
  /** The table's row references, in order. */
  rowRefs: string[];
  sourceRow: PodsObject;
  /** The source row's reference in the table's row list. */
  sourceRowRef: string;
  sourceCells: SourceCell[];
}

const containerOf = (model: PodsModel, classId: number, childId: string): PodsObject | undefined =>
  model.objects.find(
    o =>
      o.classId === classId &&
      parseRefList(readProp(o.properties, PROP_CONTENT_REFS) ?? '').some(token => refToObjectId(token) === childId),
  );

const lookup = (model: PodsModel, ref: string | undefined): PodsObject | undefined => {
  const id = ref ? refToObjectId(ref) : null;
  return id ? model.objects.find(o => o.objectId === id) : undefined;
};

/** The formatting a new cell's paragraph copies: the first paragraph of the source cell's first block. */
const cellParagraphSource = (model: PodsModel, cell: PodsObject, column: number): BlockSource => {
  const body = lookup(model, parseRefList(readProp(cell.properties, PROP_CONTENT_REFS) ?? '')[0]);
  const paragraph =
    body?.classId === CLASS_TEXT_BODY
      ? lookup(model, parseRefList(readProp(body.properties, PROP_ORDERED_CHILDREN) ?? '')[0])
      : undefined;
  const runToken = paragraph ? parseRefList(readProp(paragraph.properties, PROP_RUN_REF) ?? '')[0] : undefined;
  const run = lookup(model, runToken);
  if (!body || paragraph?.classId !== CLASS_PARAGRAPH || !runToken || run?.classId !== CLASS_RUN) {
    throw new FrameBridgeValidationError(
      `Column ${column + 1} of the row has no formatted paragraph to copy, so its new cell has no formatting to inherit.`,
    );
  }
  const marker = lookup(model, readProp(body.properties, PROP_LIST_MARKER_REF));
  return {
    paragraphProperties: paragraph.properties,
    run,
    endMarkRef: readProp(paragraph.properties, PROP_END_OF_PARAGRAPH_FORMATTING) ?? runToken,
    listMarker: marker?.classId === CLASS_LIST_MARKER ? marker : undefined,
  };
};

/** A table row located by the text of one of its cells. */
export interface TableRowLocation {
  cellId: string;
  actionDescId: string;
  table: PodsObject;
  /** The table's row references, in order. */
  rowRefs: string[];
  row: PodsObject;
  /** The row's reference in the table's row list. */
  rowRef: string;
}

/** Find the row holding a cell whose paragraph reads exactly `text`, and its table. */
export const locateTableRow = (model: PodsModel, text: string, slide?: PodsObject): TableRowLocation => {
  const root = findPresentationRoot(model);
  const location = locateTextBlock(model, text, slide);
  if (location.containerClassId !== CLASS_TABLE_CELL) {
    throw new FrameBridgeValidationError(`"${text}" is not inside a table cell. Name the text of a cell in the row.`);
  }
  const row = containerOf(model, CLASS_TABLE_ROW, location.containerObjectId);
  const table = row ? containerOf(model, CLASS_TABLE, row.objectId) : undefined;
  if (!row || !table) {
    throw new FrameBridgeValidationError(`The cell holding "${text}" is not listed by a table row and table.`);
  }
  const rowRefs = parseRefList(readProp(table.properties, PROP_CONTENT_REFS) ?? '');
  return {
    cellId: location.paragraphCellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    table,
    rowRefs,
    row,
    rowRef: rowRefs.find(ref => refToObjectId(ref) === row.objectId) as string,
  };
};

/** Find the row holding the paragraph `after`, its table, and each of its cells' formatting. */
export const resolveAddTableRowContext = (model: PodsModel, after: string): AddTableRowContext => {
  const { cellId, actionDescId, table, rowRefs, row: sourceRow, rowRef: sourceRowRef } = locateTableRow(model, after);
  const sourceCells = parseRefList(readProp(sourceRow.properties, PROP_CONTENT_REFS) ?? '').map((ref, column) => {
    const cell = lookup(model, ref);
    if (cell?.classId !== CLASS_TABLE_CELL) {
      throw new FrameBridgeValidationError(`Column ${column + 1} of the row is missing from the live model.`);
    }
    return { cell, paragraph: cellParagraphSource(model, cell, column) };
  });

  return { cellId, actionDescId, table, rowRefs, sourceRow, sourceRowRef, sourceCells };
};

/** A table id in the editor's form: 8 hex digits followed by zero groups. */
const tableId = (hex8: string): string => `${hex8}-0000-0000-0000-000000000000`;

/** Minted identities for one inserted row, derived from the call's seed. */
export interface RowIdentity {
  rowId: string;
  rowUniqueId: string;
}

/** Derive a row's two ids from a fresh GUID, so a conflict retry re-sends the same row. */
export const rowIdentityFromSeed = (seed: string): RowIdentity => {
  const hex = seed.replace(/-/g, '');
  return { rowId: tableId(hex.slice(0, 8)), rowUniqueId: tableId(hex.slice(8, 16)) };
};

/**
 * A block-owner guid for one column's new cell, derived from the call's seed: distinct
 * per column, and stable across a conflict retry.
 */
export const blockOwnerFromSeed = (seed: string, column: number): string => {
  const hex = seed.replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${String(column).padStart(4, '0')}-${hex.slice(20, 32)}`;
};

/** Build the `InsertRowBelow` body with identity placeholders. Pure and deterministic. */
export const buildAddTableRowBody = (
  ctx: AddTableRowContext,
  cells: string[],
  guidToken: string,
  headToken: string,
  identity: RowIdentity,
  actionDescriptorJson: string,
  createdTime: string,
  blockOwnerGuids: string[],
): Record<string, unknown> => {
  const rowRef = `{${guidToken}}{${SLOT_ROW}}`;
  const cellObjects: Array<Record<string, unknown>> = [];
  const cellRefs: string[] = [];

  ctx.sourceCells.forEach((source, column) => {
    const base = FIRST_CELL_SLOT + column * SLOTS_PER_CELL;
    const text = cells[column] ?? '';
    const columnId = readProp(source.cell.properties, PROP_COLUMN_ID) ?? '';
    const block = buildNewBlock(
      source.paragraph,
      text,
      {
        guidToken,
        textBodySlot: base + 1,
        paragraphSlot: base + 2,
        listMarkerSlot: base + 3,
        blockOwnerGuid: blockOwnerGuids[column] ?? '',
        createdTime,
      },
      new Map(),
      new Map([
        [PROP_ROW_ID, identity.rowId],
        [PROP_COLUMN_ID, columnId],
      ]),
    );
    const typed = typingParagraphAndRun(
      block.paragraphProperties,
      source.paragraph.run,
      text,
      `{${guidToken}}{${base + 4}}`,
    );

    cellRefs.push(`{${guidToken}}{${base}}`);
    cellObjects.push(
      {
        ObjectId: `${guidToken}|${base}`,
        ClassId: CLASS_TABLE_CELL,
        Properties: copyWith(
          source.cell.properties,
          new Map([
            [PROP_ROW_ID, identity.rowId],
            [PROP_LAST_MODIFIED_TIME, createdTime],
            [PROP_CONTENT_REFS, block.blockRef],
          ]),
        ),
      },
      ...block.objects.map(o =>
        o.ObjectId === block.paragraphId ? { ...o, Properties: typed.paragraphProperties } : o,
      ),
      ...(typed.runProperties
        ? [{ ObjectId: `${guidToken}|${base + 4}`, ClassId: CLASS_RUN, Properties: typed.runProperties }]
        : []),
    );
  });

  const rowRefs = [...ctx.rowRefs];
  rowRefs.splice(rowRefs.indexOf(ctx.sourceRowRef) + 1, 0, rowRef);
  const tableProperties = copyWith(
    ctx.table.properties,
    new Map([
      [PROP_CONTENT_REFS, rowRefs.join(',')],
      [PROP_ROW_COUNT, String(rowRefs.length)],
      [PROP_LAST_MODIFIED_TIME, createdTime],
    ]),
  );
  const rowProperties = copyWith(
    ctx.sourceRow.properties,
    new Map([
      [PROP_ROW_ID, identity.rowId],
      [PROP_ROW_UNIQUE_ID, identity.rowUniqueId],
      [PROP_LAST_MODIFIED_TIME, createdTime],
      [PROP_CONTENT_REFS, cellRefs.join(',')],
    ]),
  );

  const revision = {
    Id: `${guidToken}|${SLOT_REVISION}`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${guidToken}|${SLOT_GROUP}`,
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
              'InsertRowBelow',
            ],
          },
          { ObjectId: ctx.table.objectId, ClassId: CLASS_TABLE, Properties: tableProperties },
          { ObjectId: `${guidToken}|${SLOT_ROW}`, ClassId: CLASS_TABLE_ROW, Properties: rowProperties },
          ...cellObjects,
        ],
      },
    ],
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

/** The texts of a row's cells, left to right, read from a fresh model. */
const rowCellTexts = (model: PodsModel, rowRef: string): string[] => {
  const row = lookup(model, rowRef);
  if (row?.classId !== CLASS_TABLE_ROW) return [];
  return parseRefList(readProp(row.properties, PROP_CONTENT_REFS) ?? '').map(cellRef => {
    const cell = lookup(model, cellRef);
    const blockRef = cell ? parseRefList(readProp(cell.properties, PROP_CONTENT_REFS) ?? '')[0] : undefined;
    return blockRef ? (blockParagraphText(model, blockRef) ?? '') : '';
  });
};

/** The `add_table_row` action: insert a row below the row holding `after`, optionally filled. */
export const addTableRowAction: PodsWriteActionSpec<AddTableRowArgs, AddTableRowContext> = {
  kind: 'write',
  classFilter: TEXT_BLOCK_CLASSES,
  parseArgs: raw => {
    if (typeof raw.after !== 'string' || raw.after.length === 0) {
      throw new FrameBridgeValidationError(
        'add_table_row needs `after`: the exact visible text of a cell in the row to insert below.',
      );
    }
    const cells = raw.cells ?? [];
    if (!Array.isArray(cells) || cells.some(cell => typeof cell !== 'string')) {
      throw new FrameBridgeValidationError('add_table_row `cells` must be a list of strings, one per column.');
    }
    if (cells.some(cell => cell.includes('\n'))) {
      throw new FrameBridgeValidationError('add_table_row cell text cannot carry line breaks.');
    }
    return { after: raw.after, cells };
  },
  resolve: (model, args) => {
    const ctx = resolveAddTableRowContext(model, args.after);
    if (args.cells.length > ctx.sourceCells.length) {
      throw new FrameBridgeValidationError(
        `The table has ${ctx.sourceCells.length} columns but ${args.cells.length} cell texts were given.`,
      );
    }
    return ctx;
  },
  build: (ctx, args, mint: PodsMint) =>
    buildAddTableRowBody(
      ctx,
      args.cells,
      mint.guidToken,
      mint.headToken,
      rowIdentityFromSeed(mint.seed),
      JSON.stringify({ ActionId: mint.seed, ActionName: 'InsertRowBelow', ActionTime: mint.actionTime }),
      mint.actionTime,
      ctx.sourceCells.map((_, column) => blockOwnerFromSeed(mint.seed, column)),
    ),
  /**
   * Applied when the table lists a row the first resolve did not know, directly
   * below the source row, whose cells carry the requested texts.
   */
  isApplied: (model, first, args) => {
    const table = model.objects.find(o => o.objectId === first.table.objectId);
    if (!table) return false;
    const refs = parseRefList(readProp(table.properties, PROP_CONTENT_REFS) ?? '');
    const inserted = refs[refs.indexOf(first.sourceRowRef) + 1];
    if (!inserted || first.rowRefs.includes(inserted)) return false;
    const texts = rowCellTexts(model, inserted);
    return (
      texts.length === first.sourceCells.length && first.sourceCells.every((_, i) => texts[i] === (args.cells[i] ?? ''))
    );
  },
  // An insert is not idempotent — retrying one that applied adds a second row.
  idempotent: false,
  summarize: (ctx, args) => ({
    after: args.after,
    cells: args.cells,
    columns: ctx.sourceCells.length,
    rowsBefore: ctx.rowRefs.length,
  }),
  dryRunExtras: (ctx, args) => ({ after: args.after, cells: args.cells, columns: ctx.sourceCells.length }),
};

/** The client sequence hint the captured DeleteRow carried. Not server-validated. */
const DELETE_ROW_SEQUENCE = 22;

/** The validated arguments of a `delete_table_row` action. */
export interface DeleteTableRowArgs {
  /** Exact visible text of a paragraph in any cell of the row to remove. */
  row: string;
}

/**
 * Build the `DeleteRow` body, decoded from the editor's Table Layout → Delete Rows:
 * one revision resubmitting the table with the row's reference dropped from its row
 * list and the row count lowered by one. The row and its cells are not written.
 */
export const buildDeleteTableRowBody = (
  ctx: TableRowLocation,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
  modifiedTime: string,
): Record<string, unknown> => {
  const rowRefs = ctx.rowRefs.filter(ref => ref !== ctx.rowRef);
  const tableProperties = copyWith(
    ctx.table.properties,
    new Map([
      [PROP_CONTENT_REFS, rowRefs.join(',')],
      [PROP_ROW_COUNT, String(rowRefs.length)],
      [PROP_LAST_MODIFIED_TIME, modifiedTime],
    ]),
  );
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
                        'DeleteRow',
                      ],
                    },
                    { ObjectId: ctx.table.objectId, ClassId: CLASS_TABLE, Properties: tableProperties },
                  ],
                },
              ],
              IsFolderCell: false,
            },
          ],
          ExpectedLatestId: headToken,
          Sequence: DELETE_ROW_SEQUENCE,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** The `delete_table_row` action: remove the table row holding the cell text `row`. */
export const deleteTableRowAction: PodsWriteActionSpec<DeleteTableRowArgs, TableRowLocation> = {
  kind: 'write',
  classFilter: TEXT_BLOCK_CLASSES,
  parseArgs: raw => {
    if (typeof raw.row !== 'string' || raw.row.length === 0) {
      throw new FrameBridgeValidationError(
        'delete_table_row needs `row`: the exact visible text of a cell in the row to remove.',
      );
    }
    return { row: raw.row };
  },
  resolve: (model, args) => {
    const ctx = locateTableRow(model, args.row);
    if (ctx.rowRefs.length <= 1) {
      throw new FrameBridgeValidationError('That is the only row in the table; a table cannot be left with no rows.');
    }
    return ctx;
  },
  build: (ctx, _args, mint: PodsMint) =>
    buildDeleteTableRowBody(
      ctx,
      mint.guidToken,
      mint.headToken,
      JSON.stringify({ ActionId: mint.seed, ActionName: 'DeleteRow', ActionTime: mint.actionTime }),
      mint.actionTime,
    ),
  // Applied when the table no longer lists the row — keyed on the row's identity.
  isApplied: (model, first) => {
    const table = model.objects.find(o => o.objectId === first.table.objectId);
    return (
      table !== undefined && !parseRefList(readProp(table.properties, PROP_CONTENT_REFS) ?? '').includes(first.rowRef)
    );
  },
  // Never re-issued blindly: after a delete, re-resolving by cell text could find a different row.
  idempotent: false,
  summarize: (ctx, args) => ({ row: args.row, rowsBefore: ctx.rowRefs.length }),
  dryRunExtras: (ctx, args) => ({ row: args.row, rowsBefore: ctx.rowRefs.length }),
};
