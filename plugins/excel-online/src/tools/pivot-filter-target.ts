import { ToolError } from '@opentabs-dev/plugin-sdk';
import {
  findPivotTable,
  pageFilterCell,
  readConnections,
  readPivotCaches,
  readPivotTables,
  toFilterFieldId,
} from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';

/**
 * Where a PivotTable's page-filter operations are addressed, and which field
 * they act on.
 *
 * Both filter methods need the same two values and neither can be taken from
 * the tool's own arguments: the page-filter block's one-based cell, and the
 * field id. Deriving them from the workbook package rather than asking the
 * caller keeps a number the caller cannot verify out of the interface, and lets
 * a wrong field name fail with the list of real ones.
 */
export interface PivotFilterTarget {
  cell: { SheetName: string; NamedObjectName: string; FirstRow: number; FirstColumn: number };
  fieldId: string;
}

/**
 * Said whenever a filter is missing from the workbook package.
 *
 * The cell a page-filter method is addressed by depends on the filter's position
 * in the pivot's filter list, so this resolution has to read the saved workbook
 * — and the saved workbook trails the open session by however long Excel takes
 * to autosave. A filter placed by `add_pivot_field` moments earlier is live and
 * absent here at the same time.
 *
 * Worth the words because the obvious reading of "no page filters" is that the
 * add did not happen, and acting on that adds the field a second time.
 */
const SAVE_LAG_NOTE =
  'This reads the saved workbook, which trails the open session until Excel autosaves. ' +
  'If add_pivot_field just placed this filter, it is already live — wait for the save to catch up and call again rather than adding the field again, which would place a second copy.';

/**
 * Resolve the PivotTable on `worksheet` and the page filter identified by
 * `field`, which may be a caption ("Invoice Month") or a numeric field id.
 */
export const resolvePivotFilterTarget = async (
  worksheet: string,
  field: string,
  pivotName?: string,
): Promise<PivotFilterTarget> => {
  const pkg = await fetchWorkbookPackage();
  const caches = await readPivotCaches(pkg, await readConnections(pkg));
  const tables = await readPivotTables(pkg, caches);

  const table = findPivotTable(tables, worksheet, pivotName);
  if (!table) {
    const onSheet = tables.filter(candidate => candidate.worksheet === worksheet).map(candidate => candidate.name);
    throw ToolError.validation(
      onSheet.length === 0
        ? `No PivotTable on worksheet "${worksheet}". Worksheets with PivotTables: ${
            [...new Set(tables.map(t => t.worksheet))].join(', ') || '(none in this workbook)'
          }.`
        : `Worksheet "${worksheet}" has ${onSheet.length} PivotTables (${onSheet.join(', ')}) — pass pivot_name to choose one.`,
    );
  }

  if (table.filters.length === 0) {
    throw ToolError.validation(
      `PivotTable "${table.name}" on "${worksheet}" has no page filters in the saved workbook, so there is no filter to read or set. ` +
        `${SAVE_LAG_NOTE} ` +
        'If it genuinely has none, use add_pivot_field with zone "filters" to put a field into the Filters zone first.',
    );
  }

  // Matched by position as well as identity, because the cell each filter is
  // addressed by depends on where it sits in the list.
  const filterIndex = table.filters.findIndex(
    filter => filter.caption === field || String(filter.fieldIndex) === field.trim(),
  );
  const match = table.filters[filterIndex];
  if (!match) {
    throw ToolError.validation(
      `PivotTable "${table.name}" has no page filter "${field}" in the saved workbook. Its page filters are: ${table.filters
        .map(filter => `${filter.caption} (field_index ${filter.fieldIndex})`)
        .join(', ')}. ${SAVE_LAG_NOTE}`,
    );
  }

  const cell = pageFilterCell(table, filterIndex);
  if (!cell) {
    throw ToolError.validation(
      `Could not locate the cell for page filter "${match.caption}" on "${worksheet}": PivotTable "${table.name}" is anchored at ${table.anchor} with ${table.filters.length} page filters, which puts its filter block above the top of the sheet.`,
    );
  }

  return {
    cell: { SheetName: worksheet, NamedObjectName: '', FirstRow: cell.row, FirstColumn: cell.column },
    fieldId: toFilterFieldId(match.fieldIndex),
  };
};
