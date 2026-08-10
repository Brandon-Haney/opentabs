/**
 * The index every PivotTable method addresses a pivot's data source by.
 *
 * A PivotTable has exactly one cache and therefore exactly one data source, so
 * this is never a caller's decision — and it is zero for every method, the field
 * well and the page filters alike. Captured from Excel's own client driving a
 * pivot built over the workbook's *third* connection: `GetPivotFilterData` and
 * `ApplyFilter` both send `0`, so this indexes the pivot's own sources and has
 * nothing to do with the workbook's connection list.
 *
 * Held here rather than exposed as a tool argument because the obvious way to
 * check the value does not work. `GetPivotFieldManagerData` locates the pivot
 * from the cell alone and returns the right field well whatever index it is
 * handed, so a wrong value survives the read that is meant to establish it and
 * fails later, on the write, as a bare `InternalError` naming nothing.
 */
export const PIVOT_DATA_SOURCE_INDEX = 0;
