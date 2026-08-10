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
 * Data-source index the page-filter methods address a PivotTable's model by.
 *
 * It indexes the PivotTable's *own* sources, one-based — not the workbook's
 * connection list, which is the reading the name invites and which is wrong.
 * Captured from Excel's own client: a pivot built on the workbook's second
 * connection is still addressed as `1`. A PivotTable has exactly one cache and
 * therefore one source, so every pivot reachable here answers to `1`, and
 * deriving the value per pivot would only ever reproduce this constant.
 *
 * Zero is accepted by the field-layout methods and rejected by these, which is
 * worth knowing because the rejection surfaces as a generic out-of-sync error
 * rather than a bad-argument one.
 */
export const FILTER_DATA_SOURCE_INDEX = 1;

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
      `PivotTable "${table.name}" on "${worksheet}" has no page filters, so there is no filter to read or set. ` +
        'Use add_pivot_field with zone "filters" to put a field into the Filters zone first.',
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
      `PivotTable "${table.name}" has no page filter "${field}". Its page filters are: ${table.filters
        .map(filter => `${filter.caption} (field_index ${filter.fieldIndex})`)
        .join(', ')}.`,
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
